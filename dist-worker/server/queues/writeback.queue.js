import { Queue } from "bullmq";
import { WRITEBACK_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";
const logger = createLogger({ module: "writeback-queue" });
let queue = null;
export function getWritebackQueue() {
    if (!queue) {
        queue = new Queue(WRITEBACK_QUEUE_NAME, {
            connection: queueConnection,
        });
    }
    return queue;
}
export async function enqueueWritebackJob(data) {
    await getWritebackQueue().add("writeback", data, {
        jobId: `${data.batchId}_${data.candidateId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 2_000 },
    });
    logger.info({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
        altPlane: data.altPlane,
    }, "writeback.queue.enqueued");
}
