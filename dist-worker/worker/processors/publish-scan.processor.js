import { createLogger } from "../../server/utils/logger";
import { publishScanResult, } from "../../server/modules/scan/catalog/publish.service";
import { releaseLockByType } from "../../server/modules/lock/operation-lock.service";
import { updateScanProgressPhase, setScanProgressStatus, } from "../../server/sse/progress-publisher";
import { SCAN_PHASE } from "../../server/modules/scan/scan.constants";
const logger = createLogger({ module: "publish-scan-processor" });
const defaultDependencies = {
    publishScanResult,
    releaseLockByType,
};
const publishProcessorDependencies = {
    ...defaultDependencies,
};
export function setPublishProcessorDependenciesForTests(overrides) {
    Object.assign(publishProcessorDependencies, overrides);
}
export function resetPublishProcessorDependenciesForTests() {
    Object.assign(publishProcessorDependencies, defaultDependencies);
}
export default function createPublishScanProcessor(worker) {
    worker.on("completed", async (job) => {
        logger.info({ jobId: job.id, data: job.data }, "publish-scan.completed");
    });
    worker.on("failed", async (job, err) => {
        logger.error({ jobId: job?.id, data: job?.data, err: err.message }, "publish-scan.failed");
    });
}
export async function processPublishScanJob(data) {
    logger.info(data, "publish-scan.start");
    // 更新 Redis 进度阶段为 publish
    await updateScanProgressPhase(data.scanJobId, SCAN_PHASE.PUBLISH, "正在发布扫描结果…");
    try {
        const result = await publishProcessorDependencies.publishScanResult(data);
        await publishProcessorDependencies.releaseLockByType(data.shopId, "SCAN");
        // 标记 Redis 进度为 done
        await updateScanProgressPhase(data.scanJobId, SCAN_PHASE.DONE, result.skipped
            ? result.reason ?? "发布跳过"
            : "扫描完成！结果已发布");
        await setScanProgressStatus(data.scanJobId, "SUCCESS");
        logger.info({
            ...data,
            skipped: result.skipped,
            reason: result.reason,
            publishedTargetCount: result.publishedTargetCount,
            publishedUsageCount: result.publishedUsageCount,
            candidateCount: result.candidateCount,
            projectionCount: result.projectionCount,
        }, "publish-scan.done");
        return result;
    }
    catch (error) {
        await publishProcessorDependencies.releaseLockByType(data.shopId, "SCAN");
        // 标记 Redis 进度为 failed
        await setScanProgressStatus(data.scanJobId, "FAILED");
        throw error;
    }
}
