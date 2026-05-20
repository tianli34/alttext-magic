/**
 * File: server/queues/writeback.queue.ts
 * Purpose: writeback 队列生产者，按单条候选投递 Shopify Alt 写回任务。
 */
import { AltPlane } from "@prisma/client";
import { Queue } from "bullmq";
import { WRITEBACK_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";

const logger = createLogger({ module: "writeback-queue" });

export interface WritebackJobData {
  shopId: string;
  candidateId: string;
  batchId: string;
  lockId: string;
  altPlane: AltPlane;
  shopifyGid: string;
  altText: string;
}

let queue: Queue<WritebackJobData> | null = null;

export function getWritebackQueue(): Queue<WritebackJobData> {
  if (!queue) {
    queue = new Queue<WritebackJobData>(WRITEBACK_QUEUE_NAME, {
      connection: queueConnection,
    });
  }

  return queue;
}

export async function enqueueWritebackJob(data: WritebackJobData): Promise<void> {
  await getWritebackQueue().add("writeback", data, {
    jobId: `${data.batchId}_${data.candidateId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  });

  logger.info(
    {
      shopId: data.shopId,
      batchId: data.batchId,
      candidateId: data.candidateId,
      altPlane: data.altPlane,
    },
    "writeback.queue.enqueued",
  );
}
