/**
 * File: worker/processors/derive-scan.processor.ts
 * Purpose: derive-scan Job 处理器 — 将 staging 数据推导为待发布结果层。
 *
 * 流程:
 * 1. 读取成功 attempt 的 staging 数据
 * 2. derive 为 `scan_result_target` / `scan_result_usage`
 * 3. derive 成功后再把 scan_task 标记为 SUCCESS
 * 4. 触发 scan_job 终态收敛
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import type { DeriveScanJobData } from "../../server/queues/derive-scan.queue";
import {
  deriveAndPersistScanResults,
} from "../../server/modules/scan/catalog/derive.service";
import prisma from "../../server/db/prisma.server";
import {
  finalizeScanJobIfTerminal as finalizeScanJobIfTerminalInDb,
  markScanTaskFailed,
  markScanTaskSucceeded,
} from "../../server/modules/scan/catalog/scan-task.service";

const logger = createLogger({ module: "derive-scan-processor" });

interface DeriveProcessorDependencies {
  deriveAndPersistScanResults: typeof deriveAndPersistScanResults;
  markScanTaskSucceeded: typeof markScanTaskSucceeded;
  markScanTaskFailed: typeof markScanTaskFailed;
  finalizeScanJobIfTerminal(scanJobId: string): Promise<void>;
  getTaskSuccessfulAttemptId(scanTaskId: string): Promise<string | null>;
}

const defaultDependencies: DeriveProcessorDependencies = {
  deriveAndPersistScanResults,
  markScanTaskSucceeded,
  markScanTaskFailed,
  async finalizeScanJobIfTerminal(scanJobId) {
    await finalizeScanJobIfTerminalInDb(scanJobId);
  },
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

const deriveProcessorDependencies: DeriveProcessorDependencies = {
  ...defaultDependencies,
};

export function setDeriveProcessorDependenciesForTests(
  overrides: Partial<DeriveProcessorDependencies>,
): void {
  Object.assign(deriveProcessorDependencies, overrides);
}

export function resetDeriveProcessorDependenciesForTests(): void {
  Object.assign(deriveProcessorDependencies, defaultDependencies);
}

/* ------------------------------------------------------------------ */
/*  Processor 工厂                                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  核心处理函数（供 worker/index.ts 直接调用）                          */
/* ------------------------------------------------------------------ */

/**
 * 处理 derive-scan Job。
 *
 * @param data - Job 数据（shopId, scanJobId, scanTaskId, scanTaskAttemptId）
 */
export async function processDeriveScanJob(
  data: DeriveScanJobData,
): Promise<void> {
  const { shopId, scanJobId, scanTaskId, scanTaskAttemptId } = data;

  logger.info(
    { shopId, scanTaskId, scanTaskAttemptId },
    "derive-scan.start",
  );

  try {
    const result = await deriveProcessorDependencies.deriveAndPersistScanResults({
      scanTaskAttemptId,
    });

    if (result.skipped) {
      const successfulAttemptId =
        await deriveProcessorDependencies.getTaskSuccessfulAttemptId(scanTaskId);

      if (successfulAttemptId !== scanTaskAttemptId) {
        logger.warn(
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
    await deriveProcessorDependencies.markScanTaskSucceeded({
      scanTaskId,
      scanTaskAttemptId,
      finishedAt,
    });
    await deriveProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);

    logger.info(
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

    await deriveProcessorDependencies.markScanTaskFailed({
      scanTaskId,
      errorMessage: `[DERIVE_FAILED] ${errorMessage}`,
      finishedAt,
    });
    await deriveProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);

    throw error;
  }
}
