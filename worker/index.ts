/**
 * File: worker/index.ts
 * Purpose: Boot BullMQ workers for persisted Shopify webhook events and scan-start jobs.
 */
import { Worker } from "bullmq";
import { processWebhookEvent } from "../app/lib/server/webhooks/webhook-process.service.js";
import {
  SCAN_START_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
} from "../server/config/queue-names.js";
import {
  createRedisConnection,
  getRedisConnectionSummary,
} from "../server/queues/connection.js";
import { createLogger } from "../server/utils/logger.js";
import type { WebhookQueueJobData } from "../app/lib/server/webhooks/webhook.types.js";
import type { ScanStartJobData } from "../server/queues/scan-start.queue.js";
import { processScanStartJob } from "../server/modules/scan/catalog/scan-start.service.js";

const logger = createLogger({ module: "worker-runtime" });
const webhookConnection = createRedisConnection();
const scanStartConnection = createRedisConnection();

const webhookWorker = new Worker<WebhookQueueJobData>(
  WEBHOOK_QUEUE_NAME,
  async (job) => {
    await processWebhookEvent(job.data.webhookEventId);
  },
  {
    connection: webhookConnection,
    concurrency: 5,
  },
);

const scanStartWorker = new Worker<ScanStartJobData>(
  SCAN_START_QUEUE_NAME,
  async (job) => {
    await processScanStartJob(job.data.scanJobId);
  },
  {
    connection: scanStartConnection,
    concurrency: 2,
  },
);

webhookWorker.on("ready", () => {
  logger.info(
    {
      queue: WEBHOOK_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

scanStartWorker.on("ready", () => {
  logger.info(
    {
      queue: SCAN_START_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

webhookWorker.on("completed", (job) => {
  logger.info(
    {
      queue: WEBHOOK_QUEUE_NAME,
      jobId: job.id,
      webhookEventId: job.data.webhookEventId,
    },
    "worker.completed",
  );
});

scanStartWorker.on("completed", (job) => {
  logger.info(
    {
      queue: SCAN_START_QUEUE_NAME,
      jobId: job.id,
      scanJobId: job.data.scanJobId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

webhookWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: WEBHOOK_QUEUE_NAME,
      jobId: job?.id,
      webhookEventId: job?.data.webhookEventId,
      err: error,
    },
    "worker.failed",
  );
});

scanStartWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: SCAN_START_QUEUE_NAME,
      jobId: job?.id,
      scanJobId: job?.data.scanJobId,
      shopId: job?.data.shopId,
      err: error,
    },
    "worker.failed",
  );
});

webhookWorker.on("error", (error) => {
  logger.error({ queue: WEBHOOK_QUEUE_NAME, err: error }, "worker.error");
});

scanStartWorker.on("error", (error) => {
  logger.error({ queue: SCAN_START_QUEUE_NAME, err: error }, "worker.error");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "worker.shutdown");
  await Promise.all([webhookWorker.close(), scanStartWorker.close()]);
  await Promise.all([webhookConnection.quit(), scanStartConnection.quit()]);
  process.exit(0);
}

void (async () => {
  logger.info(
    {
      queues: [WEBHOOK_QUEUE_NAME, SCAN_START_QUEUE_NAME],
      redis: getRedisConnectionSummary(),
    },
    "worker.starting",
  );
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
