/**
 * File: worker/schedulers/reservation-reaper.scheduler.ts
 * Purpose: 注册 reservation-reaper 的 BullMQ repeatable job。
 *          每 5 分钟触发，清理过期未消费的 credit reservation。
 *
 * BullMQ repeatable job 使用 every 模式：
 *   - every: 300_000 → 每 5 分钟（300,000 毫秒）
 *   - jobId 确保同一 repeatable 只有一个实例
 */

import { getReservationReaperQueue } from "../../server/queues/reservation-reaper.queue";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "reservation-reaper-scheduler" });

/** Repeatable job 的 jobId，用于去重 */
const REPEATABLE_JOB_ID = "reservation-reaper:periodic";

/** 触发间隔：5 分钟（毫秒） */
const EVERY_MS = 5 * 60 * 1000;

/**
 * 注册 reservation-reaper 定时清理的 repeatable job。
 *
 * ### 说明
 * - BullMQ repeatable job 基于 Redis 的定时机制，无需外部 cron 守护进程。
 * - 若 repeatable job 已存在（相同 jobId + every），调用 upsert 不会重复注册。
 * - Worker 启动时调用此函数即可。
 */
export async function registerReservationReaperScheduler(): Promise<void> {
  const queue = getReservationReaperQueue();

  await queue.add(
    "reservation-reaper-scheduled",
    { source: "scheduled" },
    {
      repeat: {
        every: EVERY_MS,
      },
      jobId: REPEATABLE_JOB_ID,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );

  logger.info(
    { everyMs: EVERY_MS, jobId: REPEATABLE_JOB_ID },
    "reservation-reaper.scheduler.registered",
  );
}
