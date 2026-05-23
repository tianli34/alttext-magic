/**
 * File: server/queues/lock-reaper.queue.ts
 * Purpose: lock-reaper 队列模块——声明期，后续 Task 实现。
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { LOCK_REAPER_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "lock-reaper-queue" });

export interface LockReaperJobData {
  source: string;
}

let _queue: Queue<LockReaperJobData> | null = null;

function getQueue(): Queue<LockReaperJobData> {
  if (!_queue) {
    _queue = new Queue<LockReaperJobData>(LOCK_REAPER_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

export function getLockReaperQueue(): Queue<LockReaperJobData> {
  return getQueue();
}

export async function enqueueLockReaper(data: LockReaperJobData): Promise<void> {
  const queue = getQueue();
  await queue.add("lock-reaper", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  logger.info({ source: data.source }, "lock-reaper.enqueue");
}
