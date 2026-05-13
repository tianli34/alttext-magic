/**
 * File: server/queues/billing-sync.queue.ts
 * Purpose: billing-sync 队列模块。
 *          将订阅同步任务入列 BullMQ，供 Worker 异步消费。
 *          支持两种模式：
 *          - 单 shop 同步（shopDomain 存在）：由 callback/webhook 触发
 *          - 批量同步（shopDomain 为空）：由定时调度触发
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { BILLING_SYNC_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "billing-sync-queue" });

/** billing-sync 任务的 Job Data */
export interface BillingSyncJobData {
  /** 店铺域名（单 shop 同步时必传；批量模式时为空） */
  shopDomain?: string;
  /** 来源标识（如 "callback"、"webhook"、"scheduled"） */
  source: string;
}

/** 单例队列实例（懒初始化） */
let _queue: Queue<BillingSyncJobData> | null = null;

function getQueue(): Queue<BillingSyncJobData> {
  if (!_queue) {
    _queue = new Queue<BillingSyncJobData>(BILLING_SYNC_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

/**
 * 获取队列实例（供 scheduler 注册 repeatable job 使用）。
 */
export function getBillingSyncQueue(): Queue<BillingSyncJobData> {
  return getQueue();
}

/**
 * 将订阅同步任务入队 BullMQ（单 shop 模式）。
 * @param data 包含 shopDomain 和 source 的任务数据
 */
export async function enqueueBillingSync(data: BillingSyncJobData): Promise<void> {
  const queue = getQueue();

  // 使用 shopDomain 作为 jobId 实现去重
  const jobId = data.shopDomain
    ? `billing-sync:${data.shopDomain}`
    : `billing-sync:batch:${Date.now()}`;

  await queue.add("billing-sync", data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });

  logger.info(
    { shopDomain: data.shopDomain, source: data.source },
    "billing-sync.queue.enqueued",
  );
}
