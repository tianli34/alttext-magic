/**
 * File: worker/schedulers/billing-sync.scheduler.ts
 * Purpose: 注册 Billing 定时同步的 BullMQ repeatable job。
 *          每 6 小时触发一次，兜底同步所有店铺的 Shopify 订阅状态。
 *
 * BullMQ repeatable job 使用 cron 表达式：
 *   EVERY_6H_CRON → 每 6 小时（UTC 00:00, 06:00, 12:00, 18:00）
 *   jobId 确保同一 cron 只有一个 repeatable job 实例
 */

import { getBillingSyncQueue } from "../../server/queues/billing-sync.queue";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "billing-sync-scheduler" });

/** Repeatable job 的 jobId，用于去重 */
const REPEATABLE_JOB_ID = "billing-sync:every-6h";

/** Cron 表达式：每 6 小时 */
const EVERY_6H_CRON = "0 */6 * * *";

/**
 * 注册 Billing 定时同步 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - 若 repeatable job 已存在（相同 jobId + cron），调用 upsert 不会重复注册。
 * - Worker 启动时调用此函数即可。
 * - 批量模式不携带 shopDomain，processor 会识别并执行全量同步。
 */
export async function registerBillingSyncScheduler(): Promise<void> {
  const queue = getBillingSyncQueue();

  await queue.add(
    "billing-sync-scheduled",
    { source: "scheduled" },
    {
      repeat: {
        pattern: EVERY_6H_CRON,
      },
      jobId: REPEATABLE_JOB_ID,
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 20 },
    },
  );

  logger.info(
    { cron: EVERY_6H_CRON, jobId: REPEATABLE_JOB_ID },
    "billing-sync.scheduler.registered",
  );
}
