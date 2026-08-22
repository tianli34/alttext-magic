import { createLogger } from "../../server/utils/logger";
import { processParseBulk } from "../../server/modules/scan/catalog/parse-bulk.service";
const logger = createLogger({ module: "parse-bulk-processor" });
export default function createParseBulkProcessor(worker) {
    worker.on("completed", async (job) => {
        logger.info({ jobId: job.id, data: job.data }, "parse-bulk.completed");
    });
    worker.on("failed", async (job, err) => {
        logger.error({ jobId: job?.id, data: job?.data, err: err.message }, "parse-bulk.failed");
    });
}
export async function processParseBulkJob(data) {
    await processParseBulk(data);
}
