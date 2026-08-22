import { createLogger } from "../../server/utils/logger";
import { executePublishScan } from "../../server/modules/scan/catalog/scan-lifecycle.service";
const logger = createLogger({ module: "publish-scan-processor" });
export default function createPublishScanProcessor(worker) {
    worker.on("completed", async (job) => {
        logger.info({ jobId: job.id, data: job.data }, "publish-scan.completed");
    });
    worker.on("failed", async (job, err) => {
        logger.error({ jobId: job?.id, data: job?.data, err: err.message }, "publish-scan.failed");
    });
}
export async function processPublishScanJob(data) {
    await executePublishScan(data);
}
