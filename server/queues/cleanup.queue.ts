/**
 * File: server/queues/cleanup.queue.ts
 * Purpose: cleanup 队列模块——声明期，后续 Task 实现。
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { CLEANUP_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "cleanup-queue" });

export interface CleanupJobData {
  source: string;
}

let _queue: Queue<CleanupJobData> | null = null;

function getQueue(): Queue<CleanupJobData> {
  if (!_queue) {
    _queue = new Queue<CleanupJobData>(CLEANUP_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

export function getCleanupQueue(): Queue<CleanupJobData> {
  return getQueue();
}

export async function enqueueCleanup(data: CleanupJobData): Promise<void> {
  const queue = getQueue();
  await queue.add("cleanup", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  logger.info({ source: data.source }, "cleanup.enqueue");
}
