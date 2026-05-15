import { createLogger } from "../../server/utils/logger";
import { deriveAndPersistScanResults, } from "../../server/modules/scan/catalog/derive.service";
import prisma from "../../server/db/prisma.server";
import { finalizeScanJobIfTerminal as finalizeScanJobIfTerminalInDb, markScanTaskFailed, markScanTaskSucceeded, } from "../../server/modules/scan/catalog/scan-task.service";
import { enqueuePublishScanResult } from "../../server/queues/publish-scan.queue";
import { releaseLockByType } from "../../server/modules/lock/operation-lock.service";
import { updateScanProgressPhase, incrementScanProgress, setScanProgressStatus, } from "../../server/sse/progress-publisher";
import { SCAN_PHASE } from "../../server/modules/scan/scan.constants";
const logger = createLogger({ module: "derive-scan-processor" });
const defaultDependencies = {
    deriveAndPersistScanResults,
    markScanTaskSucceeded,
    markScanTaskFailed,
    async finalizeScanJobIfTerminal(scanJobId) {
        return finalizeScanJobIfTerminalInDb(scanJobId);
    },
    enqueuePublishScanResult,
    releaseLockByType,
    async getTaskSuccessfulAttemptId(scanTaskId) {
        const task = await prisma.scanTask.findUnique({
            where: { id: scanTaskId },
            select: {
                successfulAttemptId: true,
            },
        });
        return task?.successfulAttemptId ?? null;
    },
};
const deriveProcessorDependencies = {
    ...defaultDependencies,
};
export function setDeriveProcessorDependenciesForTests(overrides) {
    Object.assign(deriveProcessorDependencies, overrides);
}
export function resetDeriveProcessorDependenciesForTests() {
    Object.assign(deriveProcessorDependencies, defaultDependencies);
}
/* ------------------------------------------------------------------ */
/*  Processor 工厂                                                     */
/* ------------------------------------------------------------------ */
export default function createDeriveScanProcessor(worker) {
    worker.on("completed", async (job) => {
        logger.info({ jobId: job.id, data: job.data }, "derive-scan.completed");
    });
    worker.on("failed", async (job, err) => {
        logger.error({ jobId: job?.id, data: job?.data, err: err.message }, "derive-scan.failed");
    });
}
/* ------------------------------------------------------------------ */
/*  核心处理函数（供 worker/index.ts 直接调用）                          */
/* ------------------------------------------------------------------ */
/**
 * 处理 derive-scan Job。
 *
 * @param data - Job 数据（shopId, scanJobId, scanTaskId, scanTaskAttemptId）
 */
export async function processDeriveScanJob(data) {
    const { shopId, scanJobId, scanTaskId, scanTaskAttemptId } = data;
    logger.info({ shopId, scanTaskId, scanTaskAttemptId }, "derive-scan.start");
    // 更新 Redis 进度阶段为 derive
    await updateScanProgressPhase(scanJobId, SCAN_PHASE.DERIVE, "正在推导扫描结果…");
    try {
        const result = await deriveProcessorDependencies.deriveAndPersistScanResults({
            scanTaskAttemptId,
        });
        if (result.skipped) {
            const successfulAttemptId = await deriveProcessorDependencies.getTaskSuccessfulAttemptId(scanTaskId);
            if (successfulAttemptId !== scanTaskAttemptId) {
                logger.warn({
                    shopId,
                    scanJobId,
                    scanTaskId,
                    scanTaskAttemptId,
                    reason: result.reason,
                }, "derive-scan.skipped");
            }
            return;
        }
        const finishedAt = new Date();
        await deriveProcessorDependencies.markScanTaskSucceeded({
            scanTaskId,
            scanTaskAttemptId,
            finishedAt,
        });
        // 递增 Redis 进度已完成任务数
        await incrementScanProgress(scanJobId);
        const finalizeResult = await deriveProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);
        if (finalizeResult?.transitioned &&
            (finalizeResult.status === "SUCCESS" ||
                finalizeResult.status === "PARTIAL_SUCCESS")) {
            // 标记 Redis 进度为最终状态
            await setScanProgressStatus(scanJobId, finalizeResult.status);
            await deriveProcessorDependencies.enqueuePublishScanResult({
                shopId,
                scanJobId,
            });
        }
        if (finalizeResult?.transitioned && finalizeResult.status === "FAILED") {
            await setScanProgressStatus(scanJobId, finalizeResult.status);
            await deriveProcessorDependencies.releaseLockByType(shopId, "SCAN");
        }
        logger.info({
            shopId,
            scanJobId,
            scanTaskId,
            scanTaskAttemptId,
            resourceType: result.resourceType,
            targetCount: result.targetCount,
            usageCount: result.usageCount,
            warningCount: result.warnings.length,
        }, "derive-scan.success");
    }
    catch (error) {
        const finishedAt = new Date();
        const errorMessage = error instanceof Error ? error.message : String(error);
        await deriveProcessorDependencies.markScanTaskFailed({
            scanTaskId,
            errorMessage: `[DERIVE_FAILED] ${errorMessage}`,
            finishedAt,
        });
        // 递增 Redis 进度（即使是失败的 task 也算"处理完毕"）
        await incrementScanProgress(scanJobId);
        const finalizeResult = await deriveProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);
        if (finalizeResult?.transitioned &&
            (finalizeResult.status === "SUCCESS" ||
                finalizeResult.status === "PARTIAL_SUCCESS")) {
            await setScanProgressStatus(scanJobId, finalizeResult.status);
            await deriveProcessorDependencies.enqueuePublishScanResult({
                shopId,
                scanJobId,
            });
        }
        if (finalizeResult?.transitioned && finalizeResult.status === "FAILED") {
            await setScanProgressStatus(scanJobId, finalizeResult.status);
            await deriveProcessorDependencies.releaseLockByType(shopId, "SCAN");
        }
        throw error;
    }
}
