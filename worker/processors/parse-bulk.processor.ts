/**
 * File: worker/processors/parse-bulk.processor.ts
 * Purpose: parse_bulk_to_staging Job 处理器（薄壳）— 业务编排见 server/modules/scan/catalog/parse-bulk.service.ts。
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import type { ParseBulkJobData } from "../../server/queues/parse-bulk.queue";
import { processParseBulk } from "../../server/modules/scan/catalog/parse-bulk.service";

const logger = createLogger({ module: "parse-bulk-processor" });

export default function createParseBulkProcessor(
  worker: Worker<ParseBulkJobData>,
): void {
  worker.on("completed", async (job) => {
    logger.info({ jobId: job.id, data: job.data }, "parse-bulk.completed");
  });

  worker.on("failed", async (job, err) => {
    logger.error(
      { jobId: job?.id, data: job?.data, err: err.message },
      "parse-bulk.failed",
    );
  });
}

export async function processParseBulkJob(
  data: ParseBulkJobData,
): Promise<void> {
  await processParseBulk(data);
}
