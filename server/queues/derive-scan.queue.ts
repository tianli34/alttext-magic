/**
 * File: server/queues/derive-scan.queue.ts
 * Purpose: derive-scan 队列生产者。
 *
 * parse-bulk 成功后投递 derive job，用于将 staging 数据推导为候选目标。
 */
import { Queue } from "bullmq";
import { DERIVE_SCAN_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";

const logger = createLogger({ module: "derive-scan-queue" });

export interface DeriveScanJobData {
  shopId: string;
  scanJobId: string;
  scanTaskId: string;
  scanTaskAttemptId: string;
}

let queue: Queue<DeriveScanJobData> | null = null;

function getQueue(): Queue<DeriveScanJobData> {
  if (!queue) {
    queue = new Queue<DeriveScanJobData>(DERIVE_SCAN_QUEUE_NAME, {
      connection: queueConnection,
    });
  }

  return queue;
}

/**
 * 投递 derive-scan job。
 * parse-bulk 成功后调用此函数，将 staging 数据推导为候选目标。
 */
export async function enqueueDeriveScan(
  data: DeriveScanJobData,
): Promise<void> {
  await getQueue().add("derive-scan-from-staging", data, {
    jobId: data.scanTaskAttemptId,
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 },
  });

  logger.info(data, "derive-scan.queue.enqueued");
}
