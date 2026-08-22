/**
 * File: server/modules/scan/catalog/scan-lifecycle.service.ts
 * Purpose: 扫描作业生命周期编排。task 终态变化后的发布/进度/锁后续动作、
 * derive 作业编排与 publish 作业编排均收敛于此，worker 处理器仅薄壳调用。
 */
import { enqueuePublishScanResult } from "../../../queues/publish-scan.queue";
import type { PublishScanJobData } from "../../../queues/publish-scan.queue";
import type { DeriveScanJobData } from "../../../queues/derive-scan.queue";
import {
  updateScanProgressPhase,
  incrementScanProcessedImages,
  addScanResourceProcessedImages,
  setScanProgressStatus,
} from "../../../sse/progress-publisher";
import { releaseLockByType } from "../../lock/operation-lock.service";
import prisma from "../../../db/prisma.server";
import { SCAN_PHASE } from "../scan.constants";
import {
  finalizeScanJobIfTerminal,
  markScanTaskFailed,
  markScanTaskSucceeded,
  type FinalizeScanJobResult,
} from "./scan-task.service";
import { deriveAndPersistScanResults } from "./derive.service";
import {
  publishScanResult,
  type PublishExecutionResult,
} from "./publish.service";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "scan-lifecycle-service" });

export async function reconcileScanJobLifecycle(input: {
  scanJobId: string;
  shopId: string;
}): Promise<FinalizeScanJobResult | null> {
  const result = await finalizeScanJobIfTerminal(input.scanJobId);

  if (!result?.transitioned) {
    return result;
  }

  await setScanProgressStatus(input.scanJobId, result.status);

  if (result.status === "FAILED") {
    await releaseLockByType(input.shopId, "SCAN");
    return result;
  }

  await enqueuePublishScanResult(input);
  return result;
}

/* ------------------------------------------------------------------ */
/*  derive 作业编排                                                      */
/* ------------------------------------------------------------------ */

interface DeriveFlowDependencies {
  deriveAndPersistScanResults: typeof deriveAndPersistScanResults;
  markScanTaskSucceeded: typeof markScanTaskSucceeded;
  markScanTaskFailed: typeof markScanTaskFailed;
  reconcileScanJobLifecycle: typeof reconcileScanJobLifecycle;
  getTaskSuccessfulAttemptId(scanTaskId: string): Promise<string | null>;
  getAttemptTotalImages(scanTaskAttemptId: string): Promise<number>;
  getScanTaskResourceType(scanTaskId: string): Promise<string | null>;
}

const defaultDeriveFlowDependencies: DeriveFlowDependencies = {
  deriveAndPersistScanResults,
  markScanTaskSucceeded,
  markScanTaskFailed,
  reconcileScanJobLifecycle,
  async getTaskSuccessfulAttemptId(scanTaskId) {
    const task = await prisma.scanTask.findUnique({
      where: { id: scanTaskId },
      select: {
        successfulAttemptId: true,
      },
    });

    return task?.successfulAttemptId ?? null;
  },
  async getAttemptTotalImages(scanTaskAttemptId) {
    const attempt = await prisma.scanTaskAttempt.findUnique({
      where: { id: scanTaskAttemptId },
      select: { totalImages: true },
    });

    return attempt?.totalImages ?? 0;
  },
  async getScanTaskResourceType(scanTaskId) {
    const task = await prisma.scanTask.findUnique({
      where: { id: scanTaskId },
      select: { resourceType: true },
    });

    return task?.resourceType ?? null;
  },
};

const deriveFlowDependencies: DeriveFlowDependencies = {
  ...defaultDeriveFlowDependencies,
};

export function setDeriveFlowDependenciesForTests(
  overrides: Partial<DeriveFlowDependencies>,
): void {
  Object.assign(deriveFlowDependencies, overrides);
}

export function resetDeriveFlowDependenciesForTests(): void {
  Object.assign(deriveFlowDependencies, defaultDeriveFlowDependencies);
}

/**
 * derive-scan 作业的完整编排:
 * 进度阶段 → derive 落库 → task 终态 → Redis 进度递增 → scan_job 生命周期收敛。
 */
export async function processDeriveScanTask(
  data: DeriveScanJobData,
): Promise<void> {
  const { shopId, scanJobId, scanTaskId, scanTaskAttemptId } = data;

  const jobLogger = logger.withContext({
    shop_domain: shopId,
    batch_id: scanJobId,
    job_item_id: scanTaskAttemptId,
  });

  jobLogger.info(
    { shopId, scanTaskId, scanTaskAttemptId },
    "derive-scan.start",
  );

  // 更新 Redis 进度阶段为 derive
  await updateScanProgressPhase(
    scanJobId,
    SCAN_PHASE.DERIVE,
    "正在推导扫描结果…",
  );

  try {
    const result = await deriveFlowDependencies.deriveAndPersistScanResults({
      scanTaskAttemptId,
    });

    if (result.skipped) {
      const successfulAttemptId =
        await deriveFlowDependencies.getTaskSuccessfulAttemptId(scanTaskId);

      if (successfulAttemptId !== scanTaskAttemptId) {
        jobLogger.warn(
          {
            shopId,
            scanJobId,
            scanTaskId,
            scanTaskAttemptId,
            reason: result.reason,
          },
          "derive-scan.skipped",
        );
      }

      return;
    }

    const finishedAt = new Date();
    await deriveFlowDependencies.markScanTaskSucceeded({
      scanTaskId,
      scanTaskAttemptId,
      finishedAt,
    });

    // 递增 Redis 进度：任务数 + 已处理图片数
    const attemptTotalImages =
      await deriveFlowDependencies.getAttemptTotalImages(scanTaskAttemptId);
    await incrementScanProcessedImages(scanJobId, attemptTotalImages);
    const resourceType =
      result.resourceType ??
      (await deriveFlowDependencies.getScanTaskResourceType(scanTaskId));
    if (resourceType) {
      await addScanResourceProcessedImages(scanJobId, resourceType, attemptTotalImages);
    }

    await deriveFlowDependencies.reconcileScanJobLifecycle({ scanJobId, shopId });

    jobLogger.info(
      {
        shopId,
        scanJobId,
        scanTaskId,
        scanTaskAttemptId,
        resourceType: result.resourceType,
        targetCount: result.targetCount,
        usageCount: result.usageCount,
        warningCount: result.warnings.length,
      },
      "derive-scan.success",
    );
  } catch (error) {
    const finishedAt = new Date();
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    await deriveFlowDependencies.markScanTaskFailed({
      scanTaskId,
      errorMessage: `[DERIVE_FAILED] ${errorMessage}`,
      finishedAt,
    });

    // 递增 Redis 进度（即使是失败的 task 也算"处理完毕"）
    const failedAttemptImages =
      await deriveFlowDependencies.getAttemptTotalImages(scanTaskAttemptId);
    await incrementScanProcessedImages(scanJobId, 0, failedAttemptImages);
    const failedResourceType =
      await deriveFlowDependencies.getScanTaskResourceType(scanTaskId);
    if (failedResourceType) {
      await addScanResourceProcessedImages(scanJobId, failedResourceType, 0, failedAttemptImages);
    }

    await deriveFlowDependencies.reconcileScanJobLifecycle({ scanJobId, shopId });

    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  publish 作业编排                                                     */
/* ------------------------------------------------------------------ */

interface PublishFlowDependencies {
  publishScanResult: typeof publishScanResult;
  releaseLockByType: typeof releaseLockByType;
}

const defaultPublishFlowDependencies: PublishFlowDependencies = {
  publishScanResult,
  releaseLockByType,
};

const publishFlowDependencies: PublishFlowDependencies = {
  ...defaultPublishFlowDependencies,
};

export function setPublishFlowDependenciesForTests(
  overrides: Partial<PublishFlowDependencies>,
): void {
  Object.assign(publishFlowDependencies, overrides);
}

export function resetPublishFlowDependenciesForTests(): void {
  Object.assign(publishFlowDependencies, defaultPublishFlowDependencies);
}

/**
 * publish_scan_result 作业的完整编排:
 * 进度阶段 → 发布 → 释放 SCAN 锁 → 终态进度（成功 DONE+SUCCESS / 失败 FAILED）。
 */
export async function executePublishScan(
  data: PublishScanJobData,
): Promise<PublishExecutionResult> {
  logger.info(data, "publish-scan.start");

  // 更新 Redis 进度阶段为 publish
  await updateScanProgressPhase(
    data.scanJobId,
    SCAN_PHASE.PUBLISH,
    "正在发布扫描结果…",
  );

  try {
    const result = await publishFlowDependencies.publishScanResult(data);

    await publishFlowDependencies.releaseLockByType(data.shopId, "SCAN");

    // 标记 Redis 进度为 done
    await updateScanProgressPhase(
      data.scanJobId,
      SCAN_PHASE.DONE,
      result.skipped
        ? result.reason ?? "发布跳过"
        : "扫描完成！结果已发布",
    );
    await setScanProgressStatus(data.scanJobId, "SUCCESS");

    logger.info(
      {
        ...data,
        skipped: result.skipped,
        reason: result.reason,
        publishedTargetCount: result.publishedTargetCount,
        publishedUsageCount: result.publishedUsageCount,
        candidateCount: result.candidateCount,
        projectionCount: result.projectionCount,
      },
      "publish-scan.done",
    );

    return result;
  } catch (error) {
    await publishFlowDependencies.releaseLockByType(data.shopId, "SCAN");

    // 标记 Redis 进度为 failed
    await setScanProgressStatus(data.scanJobId, "FAILED");

    throw error;
  }
}
