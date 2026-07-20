/**
 * File: worker/schedulers/lock-timeout.scheduler.ts
 * Purpose: lock-reaper 定时调度器。
 *          注册 BullMQ repeatable job，每 7 分钟触发心跳超时锁回收。
 *
 * ### 两种锁回收机制
 * 1. cleanupExpiredLocks（expires_at 绝对过期）：由 operation-lock.service.ts 提供，
 *    此文件仍保留 runLockTimeoutCleanupOnce 作为兼容入口。
 * 2. reapExpiredLocks（heartbeat_at 心跳超时）：由 worker/jobs/lockReaper.ts 提供，
 *    通过 BullMQ repeatable job 定时触发。
 *
 * ### 触发间隔设计
 * - 采用 7 分钟（420,000 毫秒）间隔，与 reservation-reaper 的 5 分钟间隔互质，
 *   避免两者在启动后长期于同一时刻重叠触发，分散 Redis 瞬时调度压力。
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

/** 触发间隔：7 分钟（毫秒），与 reservation-reaper 的 5 分钟间隔互质以错开峰值 */
const LOCK_REAPER_EVERY_MS = 7 * 60 * 1000;

/** 旧的触发间隔：5 分钟（毫秒），用于迁移时清理历史 repeatable 键 */
const LOCK_REAPER_OLD_EVERY_MS = 5 * 60 * 1000;

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
 * - 间隔由 5 分钟调整为 7 分钟（与 reservation-reaper 互质）；注册前先清理旧的
 *   5 分钟 repeatable 键，避免新旧配置并存导致重复触发。
 * - Worker 启动时调用此函数即可。
 */
export async function registerLockReaperScheduler(): Promise<void> {
  const queue = getLockReaperQueue();

  // 清理历史 5 分钟 repeatable 键，确保间隔切换幂等
  await queue.removeRepeatable(
    "lock-reaper-scheduled",
    { every: LOCK_REAPER_OLD_EVERY_MS },
    LOCK_REAPER_REPEATABLE_JOB_ID,
  );

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
