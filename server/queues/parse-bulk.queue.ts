/**
 * File: server/queues/parse-bulk.queue.ts
 * Purpose: parse_bulk_to_staging 队列生产者。
 */
import { Queue } from "bullmq";
import { PARSE_BULK_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";

const logger = createLogger({ module: "parse-bulk-queue" });

export interface ParseBulkJobData {
  shopId: string;
  scanJobId: string;
  scanTaskId: string;
  scanTaskAttemptId: string;
}

let queue: Queue<ParseBulkJobData> | null = null;

function getQueue(): Queue<ParseBulkJobData> {
  if (!queue) {
    queue = new Queue<ParseBulkJobData>(PARSE_BULK_QUEUE_NAME, {
      connection: queueConnection,
    });
  }

  return queue;
}

export async function enqueueParseBulkToStaging(
  data: ParseBulkJobData,
): Promise<void> {
  await getQueue().add("parse-bulk-to-staging", data, {
    jobId: data.scanTaskAttemptId,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 },
  });

  logger.info(data, "parse-bulk.queue.enqueued");
}
