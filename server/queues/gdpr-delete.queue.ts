/**
 * File: server/queues/gdpr-delete.queue.ts
 * Purpose: gdpr-delete 队列模块——声明期，后续 Task 实现。
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { GDPR_DELETE_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "gdpr-delete-queue" });

export interface GdprDeleteJobData {
  shopDomain: string;
  source: string;
}

let _queue: Queue<GdprDeleteJobData> | null = null;

function getQueue(): Queue<GdprDeleteJobData> {
  if (!_queue) {
    _queue = new Queue<GdprDeleteJobData>(GDPR_DELETE_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

export function getGdprDeleteQueue(): Queue<GdprDeleteJobData> {
  return getQueue();
}

export async function enqueueGdprDelete(data: GdprDeleteJobData): Promise<void> {
  const queue = getQueue();
  await queue.add("gdpr-delete", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  logger.info({ shopDomain: data.shopDomain }, "gdpr-delete.enqueue");
}
