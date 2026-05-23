/**
 * File: worker/index.ts
 * Purpose: 启动 BullMQ worker，注册 webhook、扫描、生成、写回、计费与清理等队列处理器。
 */
import { Worker, Job } from "bullmq";
import { processWebhookEvent } from "../app/lib/server/webhooks/webhook-process.service.js";
import {
  BILLING_SYNC_QUEUE_NAME,
  CLEANUP_QUEUE_NAME,
  DERIVE_SCAN_QUEUE_NAME,
  GDPR_DELETE_QUEUE_NAME,
  GENERATE_ALT_QUEUE_NAME,
  LOCK_REAPER_QUEUE_NAME,
  PARSE_BULK_QUEUE_NAME,
  PUBLISH_SCAN_QUEUE_NAME,
  QUOTA_GRANT_QUEUE_NAME,
  RESERVATION_REAPER_QUEUE_NAME,
  SCAN_START_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
  WRITEBACK_QUEUE_NAME,
  CONTINUOUS_SCAN_QUEUE_NAME,
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
import type { ReservationReaperJobData } from "../server/queues/reservation-reaper.queue.js";
import type { GenerateAltJobData } from "../server/queues/generate-alt.queue.js";
import type { WritebackJobData } from "../server/queues/writeback.queue.js";
import type { CleanupJobData } from "../server/queues/cleanup.queue.js";
import type { GdprDeleteJobData } from "../server/queues/gdpr-delete.queue.js";
import type { LockReaperJobData } from "../server/queues/lock-reaper.queue.js";
import { processScanStartJob } from "../server/modules/scan/catalog/scan-start.service.js";
import { processParseBulkJob } from "./processors/parse-bulk.processor.js";
import { processDeriveScanJob } from "./processors/derive-scan.processor.js";
import { processPublishScanJob } from "./processors/publish-scan.processor.js";
import { processBillingSyncJob } from "./processors/billing-sync.processor.js";
import { processQuotaGrantJob } from "./processors/quota-grant.processor.js";
import { processReservationReaperJob } from "./processors/reservation-reaper.processor.js";
import {
  generateAltConcurrency,
  processGenerateAltJob,
} from "./processors/generate-alt.processor.js";
import {
  finalizeBatchIfComplete,
  markWritebackJobFailed,
  processWritebackJob,
  writebackConcurrency,
} from "./processors/writeback.processor.js";
import { processCleanupJob } from "./processors/cleanup.processor.js";
import { processGdprDeleteJob } from "./processors/gdpr-delete.processor.js";
import { processLockReaperJob } from "./processors/lock-reaper.processor.js";
import type {
  ContinuousScanDebouncePayload,
  ContinuousScanProductPayload,
  ContinuousScanCollectionPayload,
} from "../server/queues/continuous-scan.types.js";
import {
  JOB_DEBOUNCE,
  JOB_PRODUCT,
  JOB_COLLECTION,
} from "../server/queues/continuous-scan.queue.js";
import { processContinuousScanDebounceJob } from "./processors/continuous-scan-debounce.processor.js";
import { processContinuousScanProductJob } from "./processors/continuous-scan-product.processor.js";
import { processContinuousScanCollectionJob } from "./processors/continuous-scan-collection.processor.js";
import {
  DEFAULT_SCAN_TIMEOUT_SWEEP_INTERVAL_MS,
  runScanTimeoutSweepOnce,
} from "./schedulers/scan-timeout.scheduler.js";
import { registerFreeMonthlyGrantScheduler } from "./schedulers/free-monthly-grant.scheduler.js";
import { registerReservationReaperScheduler } from "./schedulers/reservation-reaper.scheduler.js";
import { registerBillingSyncScheduler } from "./schedulers/billing-sync.scheduler.js";
import { registerCleanupScheduler } from "./schedulers/cleanup.scheduler.js";
import { registerLockReaperScheduler } from "./schedulers/lock-timeout.scheduler.js";
import { withJobLogger } from "./utils/job-logger.js";

const logger = createLogger({ module: "worker-runtime" });
const webhookConnection = createRedisConnection();
const scanStartConnection = createRedisConnection();
const parseBulkConnection = createRedisConnection();
const deriveScanConnection = createRedisConnection();
const publishScanConnection = createRedisConnection();
const billingSyncConnection = createRedisConnection();
const quotaGrantConnection = createRedisConnection();
const reservationReaperConnection = createRedisConnection();
const generateAltConnection = createRedisConnection();
const writebackConnection = createRedisConnection();
const continuousScanConnection = createRedisConnection();
const cleanupConnection = createRedisConnection();
const gdprDeleteConnection = createRedisConnection();
const lockReaperConnection = createRedisConnection();
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
    await withJobLogger(job, async () => {
      await processWebhookEvent(job.data.webhookEventId);
    });
  },
  {
    connection: webhookConnection,
    concurrency: 5,
  },
);

const scanStartWorker = new Worker<ScanStartJobData>(
  SCAN_START_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processScanStartJob(job.data.scanJobId);
    });
  },
  {
    connection: scanStartConnection,
    concurrency: 2,
  },
);

const parseBulkWorker = new Worker<ParseBulkJobData>(
  PARSE_BULK_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processParseBulkJob(job.data);
    });
  },
  {
    connection: parseBulkConnection,
    concurrency: 2,
  },
);

const deriveScanWorker = new Worker<DeriveScanJobData>(
  DERIVE_SCAN_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processDeriveScanJob(job.data);
    });
  },
  {
    connection: deriveScanConnection,
    concurrency: 2,
  },
);

const publishScanWorker = new Worker<PublishScanJobData>(
  PUBLISH_SCAN_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processPublishScanJob(job.data);
    });
  },
  {
    connection: publishScanConnection,
    concurrency: 1,
  },
);

const billingSyncWorker = new Worker<BillingSyncJobData>(
  BILLING_SYNC_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processBillingSyncJob(job.data);
    });
  },
  {
    connection: billingSyncConnection,
    concurrency: 2,
  },
);

const quotaGrantWorker = new Worker<QuotaGrantJobData>(
  QUOTA_GRANT_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processQuotaGrantJob(job.data);
    });
  },
  {
    connection: quotaGrantConnection,
    concurrency: 1,
  },
);

const reservationReaperWorker = new Worker<ReservationReaperJobData>(
  RESERVATION_REAPER_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processReservationReaperJob(job.data);
    });
  },
  {
    connection: reservationReaperConnection,
    concurrency: 1,
  },
);

const generateAltWorker = new Worker<GenerateAltJobData>(
  GENERATE_ALT_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processGenerateAltJob(job.data);
    });
  },
  {
    connection: generateAltConnection,
    concurrency: generateAltConcurrency,
  },
);

const writebackWorker = new Worker<WritebackJobData>(
  WRITEBACK_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processWritebackJob(job.data);
    });
  },
  {
    connection: writebackConnection,
    concurrency: writebackConcurrency,
  },
);

const continuousScanDebounceWorker = new Worker<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
>(
  CONTINUOUS_SCAN_QUEUE_NAME,
  async (job) => {
    if (job.name !== JOB_DEBOUNCE) return;
    await withJobLogger(job, async () => {
      await processContinuousScanDebounceJob(job.data as ContinuousScanDebouncePayload);
    });
  },
  {
    connection: continuousScanConnection,
    concurrency: 10,
  },
);

const continuousScanProductWorker = new Worker<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
>(
  CONTINUOUS_SCAN_QUEUE_NAME,
  async (job) => {
    if (job.name !== JOB_PRODUCT) return;
    await withJobLogger(job, async () => {
      await processContinuousScanProductJob(job as Job<ContinuousScanProductPayload>);
    });
  },
  {
    connection: continuousScanConnection,
    concurrency: 3,
  },
);

const continuousScanCollectionWorker = new Worker<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
>(
  CONTINUOUS_SCAN_QUEUE_NAME,
  async (job) => {
    if (job.name !== JOB_COLLECTION) return;
    await withJobLogger(job, async () => {
      await processContinuousScanCollectionJob(job as Job<ContinuousScanCollectionPayload>);
    });
  },
  {
    connection: continuousScanConnection,
    concurrency: 3,
  },
);

const cleanupWorker = new Worker<CleanupJobData>(
  CLEANUP_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processCleanupJob(job.data);
    });
  },
  {
    connection: cleanupConnection,
    concurrency: 1,
  },
);

const gdprDeleteWorker = new Worker<GdprDeleteJobData>(
  GDPR_DELETE_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processGdprDeleteJob(job.data);
    });
  },
  {
    connection: gdprDeleteConnection,
    concurrency: 1,
  },
);

const lockReaperWorker = new Worker<LockReaperJobData>(
  LOCK_REAPER_QUEUE_NAME,
  async (job) => {
    await withJobLogger(job, async () => {
      await processLockReaperJob(job.data);
    });
  },
  {
    connection: lockReaperConnection,
    concurrency: 1,
  },
);

// ---- 注册 Free 月配额每日 repeatable job ----
void registerFreeMonthlyGrantScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "quota-grant-scheduler.register.failed");
});

// ---- 注册 reservation-reaper 每 5 分钟 repeatable job ----
void registerReservationReaperScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "reservation-reaper-scheduler.register.failed");
});

// ---- 注册 billing-sync 每 6 小时 repeatable job ----
void registerBillingSyncScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "billing-sync-scheduler.register.failed");
});

// ---- 注册 cleanup 每日 02:00 UTC repeatable job ----
void registerCleanupScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "cleanup-scheduler.register.failed");
});

// ---- 注册 lock-reaper 每 5 分钟 repeatable job ----
void registerLockReaperScheduler().catch((error: unknown) => {
  logger.error({ err: error }, "lock-reaper-scheduler.register.failed");
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

reservationReaperWorker.on("ready", () => {
  logger.info(
    {
      queue: RESERVATION_REAPER_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

generateAltWorker.on("ready", () => {
  logger.info(
    {
      queue: GENERATE_ALT_QUEUE_NAME,
      concurrency: generateAltConcurrency,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

writebackWorker.on("ready", () => {
  logger.info(
    {
      queue: WRITEBACK_QUEUE_NAME,
      concurrency: writebackConcurrency,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

continuousScanDebounceWorker.on("ready", () => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobName: JOB_DEBOUNCE,
      concurrency: 10,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

continuousScanProductWorker.on("ready", () => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobName: JOB_PRODUCT,
      concurrency: 3,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

continuousScanCollectionWorker.on("ready", () => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobName: JOB_COLLECTION,
      concurrency: 3,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

cleanupWorker.on("ready", () => {
  logger.info(
    {
      queue: CLEANUP_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

gdprDeleteWorker.on("ready", () => {
  logger.info(
    {
      queue: GDPR_DELETE_QUEUE_NAME,
      redis: getRedisConnectionSummary(),
    },
    "worker.ready",
  );
});

lockReaperWorker.on("ready", () => {
  logger.info(
    {
      queue: LOCK_REAPER_QUEUE_NAME,
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

reservationReaperWorker.on("completed", (job) => {
  logger.info(
    {
      queue: RESERVATION_REAPER_QUEUE_NAME,
      jobId: job.id,
      source: job.data.source,
    },
    "worker.completed",
  );
});

generateAltWorker.on("completed", (job) => {
  logger.info(
    {
      queue: GENERATE_ALT_QUEUE_NAME,
      jobId: job.id,
      batchId: job.data.batchId,
      candidateId: job.data.candidateId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

writebackWorker.on("completed", (job) => {
  logger.info(
    {
      queue: WRITEBACK_QUEUE_NAME,
      jobId: job.id,
      batchId: job.data.batchId,
      candidateId: job.data.candidateId,
      shopId: job.data.shopId,
    },
    "worker.completed",
  );
});

continuousScanDebounceWorker.on("completed", (job) => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job.id,
      jobName: job.name,
      shopId: job.data.shopId,
    },
    "debounce-worker.completed",
  );
});

continuousScanProductWorker.on("completed", (job) => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job.id,
      jobName: job.name,
      shopId: job.data.shopId,
    },
    "product-worker.completed",
  );
});

continuousScanCollectionWorker.on("completed", (job) => {
  logger.info(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job.id,
      jobName: job.name,
      shopId: job.data.shopId,
    },
    "collection-worker.completed",
  );
});

cleanupWorker.on("completed", (job) => {
  logger.info(
    {
      queue: CLEANUP_QUEUE_NAME,
      jobId: job.id,
      source: job.data.source,
    },
    "worker.completed",
  );
});

gdprDeleteWorker.on("completed", (job) => {
  logger.info(
    {
      queue: GDPR_DELETE_QUEUE_NAME,
      jobId: job.id,
      shopId: job.data.shopId,
      shopDomain: job.data.shopDomain,
      reason: job.data.reason,
    },
    "worker.completed",
  );
});

lockReaperWorker.on("completed", (job) => {
  logger.info(
    {
      queue: LOCK_REAPER_QUEUE_NAME,
      jobId: job.id,
      source: job.data.source,
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

reservationReaperWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: RESERVATION_REAPER_QUEUE_NAME,
      jobId: job?.id,
      source: job?.data.source,
      err: error,
    },
    "worker.failed",
  );
});

generateAltWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: GENERATE_ALT_QUEUE_NAME,
      jobId: job?.id,
      batchId: job?.data.batchId,
      candidateId: job?.data.candidateId,
      shopId: job?.data.shopId,
      err: error,
    },
    "worker.failed",
  );
});

writebackWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: WRITEBACK_QUEUE_NAME,
      jobId: job?.id,
      batchId: job?.data.batchId,
      candidateId: job?.data.candidateId,
      shopId: job?.data.shopId,
      attemptsMade: job?.attemptsMade,
      attempts: job?.opts.attempts,
      err: error,
    },
    "worker.failed",
  );

  if (!job) return;

  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;

  void markWritebackJobFailed(
    job.data,
    error instanceof Error ? error.message : String(error),
  )
    .then(() => finalizeBatchIfComplete(job.data))
    .catch((finalizeError: unknown) => {
      logger.error(
        {
          queue: WRITEBACK_QUEUE_NAME,
          jobId: job.id,
          batchId: job.data.batchId,
          candidateId: job.data.candidateId,
          shopId: job.data.shopId,
          err: finalizeError,
        },
        "writeback.final-failure-persist.failed",
      );
    });
});

continuousScanDebounceWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job?.id,
      jobName: job?.name,
      shopId: job?.data.shopId,
      err: error,
    },
    "debounce-worker.failed",
  );
});

continuousScanProductWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job?.id,
      jobName: job?.name,
      shopId: job?.data.shopId,
      err: error,
    },
    "product-worker.failed",
  );
});

continuousScanCollectionWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: CONTINUOUS_SCAN_QUEUE_NAME,
      jobId: job?.id,
      jobName: job?.name,
      shopId: job?.data.shopId,
      err: error,
    },
    "collection-worker.failed",
  );
});

continuousScanDebounceWorker.on("error", (error) => {
  logger.error({ queue: CONTINUOUS_SCAN_QUEUE_NAME, err: error }, "debounce-worker.error");
});

continuousScanProductWorker.on("error", (error) => {
  logger.error({ queue: CONTINUOUS_SCAN_QUEUE_NAME, err: error }, "product-worker.error");
});

continuousScanCollectionWorker.on("error", (error) => {
  logger.error({ queue: CONTINUOUS_SCAN_QUEUE_NAME, err: error }, "collection-worker.error");
});

cleanupWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: CLEANUP_QUEUE_NAME,
      jobId: job?.id,
      source: job?.data.source,
      err: error,
    },
    "worker.failed",
  );
});

gdprDeleteWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: GDPR_DELETE_QUEUE_NAME,
      jobId: job?.id,
      shopId: job?.data.shopId,
      shopDomain: job?.data.shopDomain,
      reason: job?.data.reason,
      err: error,
    },
    "worker.failed",
  );
});

lockReaperWorker.on("failed", (job, error) => {
  logger.error(
    {
      queue: LOCK_REAPER_QUEUE_NAME,
      jobId: job?.id,
      source: job?.data.source,
      err: error,
    },
    "worker.failed",
  );
});

cleanupWorker.on("error", (error) => {
  logger.error({ queue: CLEANUP_QUEUE_NAME, err: error }, "worker.error");
});

gdprDeleteWorker.on("error", (error) => {
  logger.error({ queue: GDPR_DELETE_QUEUE_NAME, err: error }, "worker.error");
});

lockReaperWorker.on("error", (error) => {
  logger.error({ queue: LOCK_REAPER_QUEUE_NAME, err: error }, "worker.error");
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

reservationReaperWorker.on("error", (error) => {
  logger.error({ queue: RESERVATION_REAPER_QUEUE_NAME, err: error }, "worker.error");
});

generateAltWorker.on("error", (error) => {
  logger.error({ queue: GENERATE_ALT_QUEUE_NAME, err: error }, "worker.error");
});

writebackWorker.on("error", (error) => {
  logger.error({ queue: WRITEBACK_QUEUE_NAME, err: error }, "worker.error");
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
    reservationReaperWorker.close(),
    generateAltWorker.close(),
    writebackWorker.close(),
    continuousScanDebounceWorker.close(),
    continuousScanProductWorker.close(),
    continuousScanCollectionWorker.close(),
    cleanupWorker.close(),
    gdprDeleteWorker.close(),
    lockReaperWorker.close(),
  ]);
  await Promise.all([
    webhookConnection.quit(),
    scanStartConnection.quit(),
    parseBulkConnection.quit(),
    deriveScanConnection.quit(),
    publishScanConnection.quit(),
    quotaGrantConnection.quit(),
    reservationReaperConnection.quit(),
    generateAltConnection.quit(),
    writebackConnection.quit(),
    continuousScanConnection.quit(),
    cleanupConnection.quit(),
    gdprDeleteConnection.quit(),
    lockReaperConnection.quit(),
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
        RESERVATION_REAPER_QUEUE_NAME,
        GENERATE_ALT_QUEUE_NAME,
        WRITEBACK_QUEUE_NAME,
        CONTINUOUS_SCAN_QUEUE_NAME,
        CLEANUP_QUEUE_NAME,
        GDPR_DELETE_QUEUE_NAME,
        LOCK_REAPER_QUEUE_NAME,
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
