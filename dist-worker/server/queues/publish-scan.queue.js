/**
 * File: server/queues/publish-scan.queue.ts
 * Purpose: publish_scan_result 队列生产者。
 */
import { Queue } from "bullmq";
import { PUBLISH_SCAN_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";
const logger = createLogger({ module: "publish-scan-queue" });
let queue = null;
function getQueue() {
    if (!queue) {
        queue = new Queue(PUBLISH_SCAN_QUEUE_NAME, {
            connection: queueConnection,
        });
    }
    return queue;
}
export async function enqueuePublishScanResult(data) {
    await getQueue().add("publish-scan-result", data, {
        jobId: data.scanJobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1_000 },
    });
    logger.info(data, "publish-scan.queue.enqueued");
}
