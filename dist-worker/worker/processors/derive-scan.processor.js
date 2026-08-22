import { createLogger } from "../../server/utils/logger";
import { processDeriveScanTask } from "../../server/modules/scan/catalog/scan-lifecycle.service";
const logger = createLogger({ module: "derive-scan-processor" });
export default function createDeriveScanProcessor(worker) {
    worker.on("completed", async (job) => {
        logger.info({ jobId: job.id, data: job.data }, "derive-scan.completed");
    });
    worker.on("failed", async (job, err) => {
        logger.error({ jobId: job?.id, data: job?.data, err: err.message }, "derive-scan.failed");
    });
}
export async function processDeriveScanJob(data) {
    await processDeriveScanTask(data);
}
