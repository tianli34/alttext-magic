/**
 * File: server/queues/scan-start.queue.ts
 * Purpose: scan-start 队列模块。
 *          将首次扫描任务入列 BullMQ，供 Worker 异步消费。
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { SCAN_START_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "scan-start-queue" });

/** scan-start 任务的 Job Data */
export interface ScanStartJobData {
  shopId: string;
  scanJobId: string;
  scopeFlags: Record<string, boolean>;
}

/** 单例队列实例（懒初始化） */
let _queue: Queue<ScanStartJobData> | null = null;

function getQueue(): Queue<ScanStartJobData> {
  if (!_queue) {
    _queue = new Queue<ScanStartJobData>(SCAN_START_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

/**
 * 将首次扫描任务入队 BullMQ。
 * @param data 包含 shopId、scanJobId、scopeFlags 的任务数据
 */
export async function enqueueScanStart(data: ScanStartJobData): Promise<void> {
  const queue = getQueue();

  await queue.add("scan-start", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
  });

  logger.info(
    { shopId: data.shopId, scanJobId: data.scanJobId },
    "scan-start.queue.enqueued",
  );
}
