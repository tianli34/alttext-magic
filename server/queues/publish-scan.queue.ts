/**
 * File: server/queues/publish-scan.queue.ts
 * Purpose: publish_scan_result 队列生产者。
 */
import { Queue } from "bullmq";
import { PUBLISH_SCAN_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";

const logger = createLogger({ module: "publish-scan-queue" });

export interface PublishScanJobData {
  shopId: string;
  scanJobId: string;
}

let queue: Queue<PublishScanJobData> | null = null;

function getQueue(): Queue<PublishScanJobData> {
  if (!queue) {
    queue = new Queue<PublishScanJobData>(PUBLISH_SCAN_QUEUE_NAME, {
      connection: queueConnection,
    });
  }

  return queue;
}

export async function enqueuePublishScanResult(
  data: PublishScanJobData,
): Promise<void> {
  await getQueue().add("publish-scan-result", data, {
    jobId: data.scanJobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 },
  });

  logger.info(data, "publish-scan.queue.enqueued");
}
