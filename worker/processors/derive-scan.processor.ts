/**
 * File: worker/processors/derive-scan.processor.ts
 * Purpose: derive-scan Job 处理器（薄壳）— 将 staging 数据推导为待发布结果层，
 * 编排见 server/modules/scan/catalog/scan-lifecycle.service.ts 的 processDeriveScanTask。
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import type { DeriveScanJobData } from "../../server/queues/derive-scan.queue";
import { processDeriveScanTask } from "../../server/modules/scan/catalog/scan-lifecycle.service";

const logger = createLogger({ module: "derive-scan-processor" });

export default function createDeriveScanProcessor(
  worker: Worker<DeriveScanJobData>,
): void {
  worker.on("completed", async (job) => {
    logger.info({ jobId: job.id, data: job.data }, "derive-scan.completed");
  });

  worker.on("failed", async (job, err) => {
    logger.error(
      { jobId: job?.id, data: job?.data, err: err.message },
      "derive-scan.failed",
    );
  });
}

export async function processDeriveScanJob(
  data: DeriveScanJobData,
): Promise<void> {
  await processDeriveScanTask(data);
}
