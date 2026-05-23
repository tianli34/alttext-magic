/**
 * File: worker/jobs/lockReaper.ts
 * Purpose: 心跳超时锁回收 Job —— 基于 heartbeat_at 判定锁是否僵死，
 *          将超时的 RUNNING 锁标记为 EXPIRED 并记录审计日志。
 *
 * ### 判定条件
 * - status = 'RUNNING'
 * - heartbeat_at < NOW() - 30 分钟（心跳超时阈值）
 *
 * ### 与 cleanupExpiredLocks 的区别
 * - cleanupExpiredLocks：基于 expires_at（绝对 TTL 过期），由 operation-lock.service.ts 提供
 * - lockReaper：基于 heartbeat_at（心跳停止检测），用于捕获 worker 僵死但仍未到 expires_at 的锁
 *
 * ### 幂等性
 * - UPDATE ... WHERE status = 'RUNNING' 天然幂等：已 EXPIRED/RELEASED 的行不会被重复更新。
 *
 * ### 调度
 * - 由 lock-reaper.scheduler.ts 注册 BullMQ repeatable job，每 5 分钟执行。
 */

import { Prisma } from "@prisma/client";
import prisma from "../../server/db/prisma.server";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "lock-reaper-job" });

/** 心跳超时阈值：30 分钟（毫秒） */
export const LOCK_HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;

/** 被回收锁的 RETURNING 行结构 */
interface ReapedLockRow {
  shop_id: string;
  lock_type: string;
}

/** 回收结果 */
export interface LockReaperResult {
  /** 被回收的锁数量 */
  reapedCount: number;
}

/**
 * 执行心跳超时锁回收。
 *
 * 1. 批量 UPDATE 所有 status=RUNNING 且 heartbeat_at 超过 30 分钟未更新的锁
 * 2. 对每个被回收的锁写一条结构化审计日志（event = lock.expired_reclaimed）
 *
 * @returns 回收的锁数量
 */
export async function reapExpiredLocks(): Promise<LockReaperResult> {
  const now = new Date();
  const heartbeatThreshold = new Date(
    now.getTime() - LOCK_HEARTBEAT_TIMEOUT_MS,
  );

  // 核心 SQL：心跳超时 → 标记 EXPIRED
  const reapedRows = await prisma.$queryRaw<Array<ReapedLockRow>>(Prisma.sql`
    UPDATE "shop_operation_lock"
    SET
      "status" = 'EXPIRED',
      "released_at" = ${now}
    WHERE
      "status" = 'RUNNING'
      AND "heartbeat_at" < ${heartbeatThreshold}
    RETURNING "shop_id", "lock_type"
  `);

  if (reapedRows.length === 0) {
    logger.info("lock-reaper.processor.no-expired");
    return { reapedCount: 0 };
  }

  // 对每个被回收的锁写审计日志
  for (const row of reapedRows) {
    logger.warn(
      {
        event: "lock.expired_reclaimed",
        shopId: row.shop_id,
        lockType: row.lock_type,
        heartbeatThreshold,
        reclaimedAt: now,
      },
      "lock.expired_reclaimed",
    );
  }

  logger.warn(
    {
      reapedCount: reapedRows.length,
      shopIds: reapedRows.map((r) => r.shop_id),
    },
    "lock-reaper.processor.reaped",
  );

  return { reapedCount: reapedRows.length };
}
