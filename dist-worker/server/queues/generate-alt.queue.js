import { Queue } from "bullmq";
import { GENERATE_ALT_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";
const logger = createLogger({ module: "generate-alt-queue" });
let queue = null;
export function getGenerateAltQueue() {
    if (!queue) {
        queue = new Queue(GENERATE_ALT_QUEUE_NAME, {
            connection: queueConnection,
        });
    }
    return queue;
}
export async function enqueueGenerateAltJob(data) {
    await getGenerateAltQueue().add("generate_alt", data, {
        jobId: `${data.batchId}:${data.candidateId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 2_000 },
    });
    logger.info(data, "generate-alt.queue.enqueued");
}
