/**
 * File: worker/processors/publish-scan.processor.ts
 * Purpose: publish_scan_result Job 处理器（薄壳）— 编排见
 * server/modules/scan/catalog/scan-lifecycle.service.ts 的 executePublishScan。
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import type { PublishScanJobData } from "../../server/queues/publish-scan.queue";
import { executePublishScan } from "../../server/modules/scan/catalog/scan-lifecycle.service";

const logger = createLogger({ module: "publish-scan-processor" });

export default function createPublishScanProcessor(
  worker: Worker<PublishScanJobData>,
): void {
  worker.on("completed", async (job) => {
    logger.info({ jobId: job.id, data: job.data }, "publish-scan.completed");
  });

  worker.on("failed", async (job, err) => {
    logger.error(
      { jobId: job?.id, data: job?.data, err: err.message },
      "publish-scan.failed",
    );
  });
}

export async function processPublishScanJob(
  data: PublishScanJobData,
): Promise<void> {
  await executePublishScan(data);
}
