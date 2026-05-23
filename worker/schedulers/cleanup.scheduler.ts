/**
 * File: worker/schedulers/cleanup.scheduler.ts
 * Purpose: 注册 Cleanup 定时任务的 BullMQ repeatable job。
 *          每天凌晨 02:00 UTC 触发，执行全量 cleanup 子任务。
 *
 * BullMQ repeatable job 使用 cron 表达式：
 *   CLEANUP_CRON → 每天 UTC 02:00
 *   jobId 确保同一 cron 只有一个 repeatable job 实例
 */

import { getCleanupQueue } from "../../server/queues/cleanup.queue.js";
import { createLogger } from "../../server/utils/logger.js";

const logger = createLogger({ module: "cleanup-scheduler" });

/** Repeatable job 的 jobId，用于去重 */
const REPEATABLE_JOB_ID = "cleanup:daily-0200";

/** Cron 表达式：每天 UTC 02:00 */
const CLEANUP_CRON = "0 2 * * *";

/**
 * 注册 Cleanup 定时 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - 若 repeatable job 已存在（相同 jobId + cron），调用 upsert 不会重复注册。
 * - Worker 启动时调用此函数即可。
 */
export async function registerCleanupScheduler(): Promise<void> {
  const queue = getCleanupQueue();

  await queue.add(
    "cleanup-scheduled",
    { source: "scheduled" },
    {
      repeat: {
        pattern: CLEANUP_CRON,
      },
      jobId: REPEATABLE_JOB_ID,
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 10 },
    },
  );

  logger.info(
    { cron: CLEANUP_CRON, jobId: REPEATABLE_JOB_ID },
    "cleanup.scheduler.registered",
  );
}
