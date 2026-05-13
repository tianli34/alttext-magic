/**
 * File: worker/schedulers/free-monthly-grant.scheduler.ts
 * Purpose: 注册 Free 月配额自动发放的 BullMQ repeatable job。
 *          每日 UTC 00:05 触发，为所有 Free 店铺发放当月配额。
 *
 * BullMQ repeatable job 使用 cron 表达式：
 *   - "5 0 * * *" → 每天 UTC 00:05
 *   - jobId 确保同一 cron 只有一个 repeatable job 实例
 */

import { getQuotaGrantQueue } from "../../server/queues/quota-grant.queue";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "free-monthly-grant-scheduler" });

/** Repeatable job 的 jobId，用于去重 */
const REPEATABLE_JOB_ID = "quota-grant:daily";

/** Cron 表达式：每日 UTC 00:05 */
const DAILY_CRON = "5 0 * * *";

/**
 * 注册 Free 月配额每日自动发放的 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - 若 repeatable job 已存在（相同 jobId + cron），调用 upsert 不会重复注册。
 * - Worker 启动时调用此函数即可。
 */
export async function registerFreeMonthlyGrantScheduler(): Promise<void> {
  const queue = getQuotaGrantQueue();

  await queue.add(
    "quota-grant-scheduled",
    { source: "scheduled" },
    {
      repeat: {
        pattern: DAILY_CRON,
      },
      jobId: REPEATABLE_JOB_ID,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );

  logger.info(
    { cron: DAILY_CRON, jobId: REPEATABLE_JOB_ID },
    "free-monthly-grant.scheduler.registered",
  );
}
