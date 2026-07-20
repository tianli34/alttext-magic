/**
 * File: worker/schedulers/free-monthly-grant.scheduler.ts
 * Purpose: 注册 Free 月配额自动发放的 BullMQ repeatable job。
 *          每日 UTC 00:05 触发，为所有 Free 店铺滚动补齐当月配额。
 *
 * BullMQ repeatable job 使用 cron 表达式：
 *   - "5 0 * * *" → 每天 UTC 00:05
 *   - 每日触发、幂等补齐当月 bucket，因此语义为「月度配额滚动发放」而非每日重置。
 *   - jobId 确保同一 cron 只有一个 repeatable job 实例。
 */

import { getQuotaGrantQueue } from "../../server/queues/quota-grant.queue";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "free-monthly-grant-scheduler" });

/** Repeatable job 的 jobId，用于去重（月度配额滚动发放，非每日重置） */
const REPEATABLE_JOB_ID = "quota-grant:monthly-rollup";

/** 旧的 jobId，用于迁移时清理历史 repeatable 键 */
const OLD_REPEATABLE_JOB_ID = "quota-grant:daily";

/** Cron 表达式：每日 UTC 00:05 */
const DAILY_CRON = "5 0 * * *";

/**
 * 注册 Free 月配额每日滚动发放的 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - jobId 由 quota-grant:daily 更名为 quota-grant:monthly-rollup；注册前先清理旧键，
 *   避免新旧 jobId 的 repeatable 并存。
 * - Worker 启动时调用此函数即可。
 */
export async function registerFreeMonthlyGrantScheduler(): Promise<void> {
  const queue = getQuotaGrantQueue();

  // 清理历史 daily jobId 的 repeatable 键，确保重命名迁移幂等
  await queue.removeRepeatable(
    "quota-grant-scheduled",
    { pattern: DAILY_CRON },
    OLD_REPEATABLE_JOB_ID,
  );

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
