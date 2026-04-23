/**
 * File: worker/processors/derive-scan.processor.ts
 * Purpose: derive-scan Job 处理器 — 将 staging 数据推导为候选目标（AltTarget + ImageUsage）。
 *
 * 流程:
 * 1. 从 scan_task_attempt 读取关联的 staging 数据
 * 2. 根据 resourceType 调用对应的 derive 逻辑
 * 3. 将推导结果写入 alt_target / image_usage 表
 * 4. 更新 scanTask 状态
 *
 * 注意: 当前为骨架实现，derive 核心逻辑将在后续任务中完成。
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import type { DeriveScanJobData } from "../../server/queues/derive-scan.queue";

const logger = createLogger({ module: "derive-scan-processor" });

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
  const { shopId, scanTaskId, scanTaskAttemptId } = data;

  logger.info(
    { shopId, scanTaskId, scanTaskAttemptId },
    "derive-scan.start",
  );

  // TODO: derive 核心逻辑将在后续任务中实现
  // 预期流程:
  // 1. 查询 staging 数据
  // 2. 推导 alt_target + image_usage
  // 3. 写入结果表
  // 4. 更新 scanTask 状态

  logger.info(
    { shopId, scanTaskId, scanTaskAttemptId },
    "derive-scan.success",
  );
}
