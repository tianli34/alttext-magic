/**
 * File: server/queues/quota-grant.queue.ts
 * Purpose: quota-grant 队列模块。
 *          将 Free 月配额自动发放任务入列 BullMQ，供 Worker 异步消费。
 *          支持两种模式：
 *          - repeatable：每日 UTC 00:05 自动触发（由 scheduler 注册）
 *          - 手动入列：测试或运维场景
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { QUOTA_GRANT_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "quota-grant-queue" });

/** quota-grant 任务的 Job Data */
export interface QuotaGrantJobData {
  /** 触发来源（如 "scheduled"、"manual"） */
  source: string;
  /** 目标月份（YYYY-MM），为空则使用当前 UTC 月份 */
  targetMonth?: string;
}

/** 单例队列实例（懒初始化） */
let _queue: Queue<QuotaGrantJobData> | null = null;

function getQueue(): Queue<QuotaGrantJobData> {
  if (!_queue) {
    _queue = new Queue<QuotaGrantJobData>(QUOTA_GRANT_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

/**
 * 获取队列实例（供 scheduler 注册 repeatable job 使用）。
 */
export function getQuotaGrantQueue(): Queue<QuotaGrantJobData> {
  return getQueue();
}

/**
 * 将 Free 月配额发放任务入队 BullMQ。
 * @param data 包含 source 和可选 targetMonth 的任务数据
 */
export async function enqueueQuotaGrant(data: QuotaGrantJobData): Promise<void> {
  const queue = getQueue();

  await queue.add("quota-grant", data, {
    jobId: `quota-grant:${data.targetMonth ?? "current"}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });

  logger.info(
    { source: data.source, targetMonth: data.targetMonth },
    "quota-grant.enqueue",
  );
}
