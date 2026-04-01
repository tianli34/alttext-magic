/**
 * File: worker/index.ts
 * Purpose: Boot the BullMQ worker that processes persisted Shopify webhook events.
 */
import { Worker } from "bullmq";
import { processWebhookEvent } from "../app/lib/server/webhooks/webhook-process.service.js";
import { WEBHOOK_QUEUE_NAME } from "../server/config/queue-names.js";
import { createRedisConnection, getRedisConnectionSummary, } from "../server/queues/connection.js";
import { createLogger } from "../server/utils/logger.js";
const logger = createLogger({ module: "webhook-worker" });
const connection = createRedisConnection();
const worker = new Worker(WEBHOOK_QUEUE_NAME, async (job) => {
    await processWebhookEvent(job.data.webhookEventId);
}, {
    connection,
    concurrency: 5,
});
worker.on("ready", () => {
    logger.info({
        queue: WEBHOOK_QUEUE_NAME,
        redis: getRedisConnectionSummary(),
    }, "Webhook worker is ready");
});
worker.on("completed", (job) => {
    logger.info({
        queue: WEBHOOK_QUEUE_NAME,
        jobId: job.id,
        webhookEventId: job.data.webhookEventId,
    }, "Webhook worker completed job");
});
worker.on("failed", (job, error) => {
    logger.error({
        queue: WEBHOOK_QUEUE_NAME,
        jobId: job?.id,
        webhookEventId: job?.data.webhookEventId,
        err: error,
    }, "Webhook worker failed job");
});
worker.on("error", (error) => {
    logger.error({ queue: WEBHOOK_QUEUE_NAME, err: error }, "Webhook worker error");
});
async function shutdown(signal) {
    logger.info({ signal }, "Shutting down webhook worker");
    await worker.close();
    await connection.quit();
    process.exit(0);
}
void (async () => {
    logger.info({
        queue: WEBHOOK_QUEUE_NAME,
        redis: getRedisConnectionSummary(),
    }, "Starting webhook worker");
})();
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        void shutdown(signal);
    });
}
