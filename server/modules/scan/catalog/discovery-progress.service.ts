/**
 * File: server/modules/scan/catalog/discovery-progress.service.ts
 * Purpose: 发现阶段不确定进度采集。
 *          轮询仍处于发现阶段（已提交 Bulk 但尚未进入解析）的 scan_task_attempt，
 *          读取 Shopify Bulk Operation 的 objectCount（查询根节点已处理对象运行计数），
 *          按 scan_job 聚合后写入 Redis discoveredObjects，供 SSE 展示
 *          「正在收集图片：已发现 N 个对象…」这种不确定进度。
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { getBulkOperationById } from "./shopify-bulk.client.server";
import { setScanDiscoveredObjects } from "../../../sse/progress-publisher";

const logger = createLogger({ module: "discovery-progress-service" });

/** 单次巡检最多处理的 attempt 数，避免对 Shopify 造成突发压力。 */
const DISCOVERY_POLL_SWEEP_LIMIT = 100;

export interface PollDiscoveryObjectCountsResult {
  /** 检查的处于发现阶段的 attempt 数 */
  checkedAttemptCount: number;
  /** 更新了 discoveredObjects 的 scan_job 数 */
  updatedJobCount: number;
  /** 查询 Shopify 失败的 attempt 数 */
  errorCount: number;
}

/**
 * 运行一次发现阶段 objectCount 采集。
 *
 * 仅处理满足以下条件的 attempt：
 * - attempt.status 为 RUNNING（已提交 Bulk、尚未进入 READY_TO_PARSE/解析）
 * - 已写入 bulkOperationId
 * - 所属 scan_job 仍为 RUNNING（非终态）
 *
 * 一旦 attempt 进入解析阶段，其不再参与本轮采集，
 * discoveredObjects 停止增长，前端自然切换到图片级精确进度。
 */
export async function pollDiscoveryObjectCounts(options?: {
  limit?: number;
}): Promise<PollDiscoveryObjectCountsResult> {
  const limit = options?.limit ?? DISCOVERY_POLL_SWEEP_LIMIT;

  const attempts = await prisma.scanTaskAttempt.findMany({
    where: {
      status: "RUNNING",
      bulkOperationId: { not: null },
      scanTask: {
        scanJob: { status: "RUNNING" },
      },
    },
    take: limit,
    select: {
      id: true,
      shopId: true,
      bulkOperationId: true,
      scanTask: {
        select: { scanJobId: true },
      },
    },
  });

  if (attempts.length === 0) {
    return { checkedAttemptCount: 0, updatedJobCount: 0, errorCount: 0 };
  }

  // 按 scanJobId 聚合各 attempt 的 objectCount。
  const objectCountByJob = new Map<string, number>();
  let errorCount = 0;

  for (const attempt of attempts) {
    const bulkOperationId = attempt.bulkOperationId;
    const scanJobId = attempt.scanTask.scanJobId;
    if (!bulkOperationId) {
      continue;
    }

    try {
      const snapshot = await getBulkOperationById(attempt.shopId, bulkOperationId);
      const objectCount = snapshot?.objectCount ?? 0;
      objectCountByJob.set(
        scanJobId,
        (objectCountByJob.get(scanJobId) ?? 0) + objectCount,
      );
    } catch (error) {
      errorCount += 1;
      logger.warn(
        {
          shopId: attempt.shopId,
          scanJobId,
          bulkOperationId,
          err: error,
        },
        "discovery-progress.object-count-failed",
      );
    }
  }

  let updatedJobCount = 0;
  for (const [scanJobId, discoveredObjects] of objectCountByJob) {
    await setScanDiscoveredObjects(scanJobId, discoveredObjects);
    updatedJobCount += 1;
  }

  return {
    checkedAttemptCount: attempts.length,
    updatedJobCount,
    errorCount,
  };
}
