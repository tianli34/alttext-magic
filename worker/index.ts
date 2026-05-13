/**
 * File: worker/index.ts
 * Purpose: Boot BullMQ workers for persisted Shopify webhook events, scan-start, parse-bulk, and quota-grant jobs.
 */
import { Worker } from "bullmq";
import { processWebhookEvent } from "../app/lib/server/webhooks/webhook-process.service.js";
import {
  BILLING_SYNC_QUEUE_NAME,
  DERIVE_SCAN_QUEUE_NAME,
  PARSE_BULK_QUEUE_NAME,
  PUBLISH_SCAN_QUEUE_NAME,
  QUOTA_GRANT_QUEUE_NAME,
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
import type { ParseBulkJobData } from "../server/queues/parse-bulk.queue.js";
import type { DeriveScanJobData } from "../server/queues/derive-scan.queue.js";
import type { PublishScanJobData } from "../server/queues/publish-scan.queue.js";
import type { BillingSyncJobData } from "../server/queues/billing-sync.queue.js";
import type { QuotaGrantJobData } from "../server/queues/quota-grant.queue.js";
import { processScanStartJob } from "../server/modules/scan/catalog/scan-start.service.js";
import { processParseBulkJob } from "./processors/parse-bulk.processor.js";
import { processDeriveScanJob } from "./processors/derive-scan.processor.js";
import { processPublishScanJob } from "./processors/publish-scan.processor.js";
import { processBillingSyncJob } from "./processors/billing-sync.processor.js";
import { processQuotaGrantJob } from "./processors/quota-grant.processor.js";
import {
  DEFAULT_SCAN_TIMEOUT_SWEEP_INTERVAL_MS,
  runScanTimeoutSweepOnce,
} from "./schedulers/scan-timeout.scheduler.js";
import { registerFreeMonthlyGrantScheduler } from "./schedulers/free-monthly-grant.scheduler.js";

const logger = createLogger({ module: "worker-runtime" });
const webhookConnection = createRedisConnection();
const scanStartConnection = createRedisConnection();
const parseBulkConnection = createRedisConnection();
const deriveScanConnection = createRedisConnection();
const publishScanConnection = createRedisConnection();
const billingSyncConnection = createRedisConnection();
const quotaGrantConnection = createRedisConnection();
let scanTimeoutSweepRunning = false;

const scanTimeoutSweepInterval = setInterval(() => {
  if (scanTimeoutSweepRunning) {
    return;
  }

  scanTimeoutSweepRunning = true;
  void runScanTimeoutSweepOnce()
    .catch((error: unknown) => {
      logger.error({ err: error }, "scan-timeout-scheduler.failed");
    })
    .finally(() => {
      scanTimeoutSweepRunning = false;
    });
}, DEFAULT_SCAN_TIMEOUT_SWEEP_INTERVAL_MS);

scanTimeoutSweepInterval.unref();

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

const parseBulkWorker = new Worker<ParseBulkJobData>(
  PARSE_BULK_QUEUE_NAME,
  async (job) => {
    await processParseBulkJob(job.data);
  },
  {
    connection: parseBulkConnection,
    concurrency: 2,
  },
);

const deriveScanWorker = new Worker<DeriveScanJobData>(
  DERIVE_SCAN_QUEUE_NAME,
  async (job) => {
    await processDeriveScanJob(job.data);
  },
  {
    connection: deriveScanConnection,
    concurrency: 2,
  },
);

const publishScanWorker = new Worker<PublishScanJobData>(
  PUBLISH_SCAN_QUEUE_NAME,
  async (job) => {
    await processPublishScanJob(job.data);
  },
  {
    connection: publishScanConnection,
    concurrency: 1,
  },
);

const billingSyncWorker = new Worker<BillingSyncJobData>(
  BILLING_SYNC_QUEUE_NAME,
  async (job) => {
    await processBillingSyncJob(job.data);
  },
  {
    connection: billingSyncConnection,
    concurrency: 2,
  },
);

const quotaGrantWorker = new Worker<QuotaGrantJobData>(
  QUOTA_GRANT_QUEUE_NAME,
  async (job) => {
    await processQuotaGrantJob(job.data);
  },
  {
    connection: quotaGrantConnection,
    concurrency: 1,
  },
);

// ---- 注册 Free 月配额每日 repeatable job ----
void registerFreeMonthlyGrantScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "quota-grant-scheduler.register.failed");
});

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

parseBulkWorker.on("ready", () => {
  logger.info(
    {
      queue: PARSE_BULK_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

deriveScanWorker.on("ready", () => {
  logger.info(
    {
      queue: DERIVE_SCAN_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

publishScanWorker.on("ready", () => {
  logger.info(
    {
      queue: PUBLISH_SCAN_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

billingSyncWorker.on("ready", () => {
  logger.info(
    {
      queue: BILLING_SYNC_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

quotaGrantWorker.on("ready", () => {
  logger.info(
    {
      queue: QUOTA_GRANT_QUEUE_NAME,
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

parseBulkWorker.on("completed", (job) => {
  logger.info(
    {
      queue: PARSE_BULK_QUEUE_NAME,
      jobId: job.id,
      scanTaskAttemptId: job.data.scanTaskAttemptId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

deriveScanWorker.on("completed", (job) => {
  logger.info(
    {
      queue: DERIVE_SCAN_QUEUE_NAME,
      jobId: job.id,
      scanTaskAttemptId: job.data.scanTaskAttemptId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

publishScanWorker.on("completed", (job) => {
  logger.info(
    {
      queue: PUBLISH_SCAN_QUEUE_NAME,
      jobId: job.id,
      scanJobId: job.data.scanJobId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

quotaGrantWorker.on("completed", (job) => {
  logger.info(
    {
      queue: QUOTA_GRANT_QUEUE_NAME,
      jobId: job.id,
      source: job.data.source,
      targetMonth: job.data.targetMonth,
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

parseBulkWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: PARSE_BULK_QUEUE_NAME,
      jobId: job?.id,
      scanTaskAttemptId: job?.data.scanTaskAttemptId,
      shopId: job?.data.shopId,
      err: error,
    },
    "worker.failed",
  );
});

deriveScanWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: DERIVE_SCAN_QUEUE_NAME,
      jobId: job?.id,
      scanTaskAttemptId: job?.data.scanTaskAttemptId,
      shopId: job?.data.shopId,
      err: error,
    },
    "worker.failed",
  );
});

publishScanWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: PUBLISH_SCAN_QUEUE_NAME,
      jobId: job?.id,
      scanJobId: job?.data.scanJobId,
      shopId: job?.data.shopId,
      err: error,
    },
    "worker.failed",
  );
});

quotaGrantWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: QUOTA_GRANT_QUEUE_NAME,
      jobId: job?.id,
      source: job?.data.source,
      targetMonth: job?.data.targetMonth,
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

parseBulkWorker.on("error", (error) => {
  logger.error({ queue: PARSE_BULK_QUEUE_NAME, err: error }, "worker.error");
});

deriveScanWorker.on("error", (error) => {
  logger.error({ queue: DERIVE_SCAN_QUEUE_NAME, err: error }, "worker.error");
});

publishScanWorker.on("error", (error) => {
  logger.error({ queue: PUBLISH_SCAN_QUEUE_NAME, err: error }, "worker.error");
});

quotaGrantWorker.on("error", (error) => {
  logger.error({ queue: QUOTA_GRANT_QUEUE_NAME, err: error }, "worker.error");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "worker.shutdown");
  clearInterval(scanTimeoutSweepInterval);
  await Promise.all([
    webhookWorker.close(),
    scanStartWorker.close(),
    parseBulkWorker.close(),
    deriveScanWorker.close(),
    publishScanWorker.close(),
    quotaGrantWorker.close(),
  ]);
  await Promise.all([
    webhookConnection.quit(),
    scanStartConnection.quit(),
    parseBulkConnection.quit(),
    deriveScanConnection.quit(),
    publishScanConnection.quit(),
    quotaGrantConnection.quit(),
  ]);
  process.exit(0);
}

void (async () => {
  logger.info(
    {
      queues: [
        WEBHOOK_QUEUE_NAME,
        SCAN_START_QUEUE_NAME,
        PARSE_BULK_QUEUE_NAME,
        DERIVE_SCAN_QUEUE_NAME,
        PUBLISH_SCAN_QUEUE_NAME,
        QUOTA_GRANT_QUEUE_NAME,
      ],
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
