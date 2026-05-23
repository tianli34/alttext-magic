/**
 * File: worker/schedulers/lock-timeout.scheduler.ts
 * Purpose: lock-reaper 定时调度器。
 *          注册 BullMQ repeatable job，每 5 分钟触发心跳超时锁回收。
 *
 * ### 两种锁回收机制
 * 1. cleanupExpiredLocks（expires_at 绝对过期）：由 operation-lock.service.ts 提供，
 *    此文件仍保留 runLockTimeoutCleanupOnce 作为兼容入口。
 * 2. reapExpiredLocks（heartbeat_at 心跳超时）：由 worker/jobs/lockReaper.ts 提供，
 *    通过 BullMQ repeatable job 定时触发。
 */

import {
  cleanupExpiredLocks,
} from "../../server/modules/lock/operation-lock.service";
import { getLockReaperQueue } from "../../server/queues/lock-reaper.queue";
import { createLogger } from "../../server/utils/logger";
import type { LockReaperJobData } from "../../server/queues/lock-reaper.queue";

const logger = createLogger({ module: "lock-timeout-scheduler" });

/** 默认建议 cadence：1 分钟巡检一次。 */
export const DEFAULT_LOCK_TIMEOUT_CLEANUP_INTERVAL_MS = 60 * 1000;

/** Repeatable job 的 jobId，用于去重 */
const LOCK_REAPER_REPEATABLE_JOB_ID = "lock-reaper:periodic";

/** 触发间隔：5 分钟（毫秒） */
const LOCK_REAPER_EVERY_MS = 5 * 60 * 1000;

/** 复用 service 层回收逻辑，避免 SQL 散落到 route / scheduler。 */
export async function runLockTimeoutCleanupOnce(): Promise<number> {
  const result = await cleanupExpiredLocks();

  if (result.cleanedCount > 0) {
    logger.warn(
      { cleanedCount: result.cleanedCount },
      "Lock timeout cleanup reclaimed expired locks",
    );
  }

  return result.cleanedCount;
}

/**
 * 注册 lock-reaper 心跳超时回收的 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - 若 repeatable job 已存在（相同 jobId + every），调用 upsert 不会重复注册。
 * - Worker 启动时调用此函数即可。
 */
export async function registerLockReaperScheduler(): Promise<void> {
  const queue = getLockReaperQueue();

  await queue.add(
    "lock-reaper-scheduled",
    { source: "scheduled" } as LockReaperJobData,
    {
      repeat: {
        every: LOCK_REAPER_EVERY_MS,
      },
      jobId: LOCK_REAPER_REPEATABLE_JOB_ID,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );

  logger.info(
    { everyMs: LOCK_REAPER_EVERY_MS, jobId: LOCK_REAPER_REPEATABLE_JOB_ID },
    "lock-reaper.scheduler.registered",
  );
}
