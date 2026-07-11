/**
 * File: server/modules/scan/catalog/bulk-attempt-reaper.service.ts
 * Purpose: 按 scan_task_attempt 维度对账 Shopify Bulk Operation 状态。
 *          当某个 bulk op 的 bulk_operations/finish webhook 丢失/延迟时，
 *          主动轮询 Shopify 真实状态并收敛（完成→投递解析 / 失败→标记失败），
 *          避免 attempt 永久卡在 RUNNING 并拖垮整单扫描。
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { getBulkOperationById } from "./shopify-bulk.client.server";
import { markAttemptFinishedFromWebhook } from "./scan-task-attempt.service";
import { enqueueParseBulkToStaging } from "../../../queues/parse-bulk.queue";

const logger = createLogger({ module: "bulk-attempt-reaper" });

/**
 * 超过该时长仍未收到 webhook 的 RUNNING attempt 才对账，
 * 避免对正常进行中的 bulk op 频繁轮询 Shopify。
 */
export const DEFAULT_BULK_ATTEMPT_RECONCILE_THRESHOLD_MS = 90_000;
const BULK_ATTEMPT_REAPER_SWEEP_LIMIT = 100;

export interface ReapStuckBulkAttemptsResult {
  checkedCount: number;
  convergedCount: number;
  stillRunningCount: number;
  failedCount: number;
  errorCount: number;
}

export async function reapStuckBulkAttempts(options?: {
  now?: Date;
  thresholdMs?: number;
  limit?: number;
}): Promise<ReapStuckBulkAttemptsResult> {
  const now = options?.now ?? new Date();
  const thresholdMs =
    options?.thresholdMs ?? DEFAULT_BULK_ATTEMPT_RECONCILE_THRESHOLD_MS;
  const limit = options?.limit ?? BULK_ATTEMPT_REAPER_SWEEP_LIMIT;
  const cutoff = new Date(now.getTime() - thresholdMs);

  const attempts = await prisma.scanTaskAttempt.findMany({
    where: {
      status: "RUNNING",
      bulkOperationId: { not: null },
      startedAt: { lte: cutoff },
    },
    take: limit,
    select: {
      id: true,
      shopId: true,
      scanTaskId: true,
      bulkOperationId: true,
    },
  });

  let convergedCount = 0;
  let stillRunningCount = 0;
  let failedCount = 0;
  let errorCount = 0;

  for (const attempt of attempts) {
    const bulkOperationId = attempt.bulkOperationId;
    if (!bulkOperationId) {
      continue;
    }

    try {
      const snapshot = await getBulkOperationById(attempt.shopId, bulkOperationId);

      if (!snapshot) {
        // Shopify 侧已查不到该 bulk op：视为失败并收敛，避免永久悬挂。
        logger.warn(
          {
            shopId: attempt.shopId,
            scanTaskId: attempt.scanTaskId,
            bulkOperationId,
          },
          "bulk-attempt-reaper.bulk-operation-missing",
        );

        const completion = await markAttemptFinishedFromWebhook({
          bulkOperationId,
          bulkOperationStatus: "FAILED",
          bulkResultUrl: null,
          finishedAt: now,
          errorCode: null,
          errorMessage: "Bulk operation not found on Shopify during reconciliation",
        });

        if (completion?.shouldEnqueueParse) {
          await enqueueParseBulkToStaging({
            shopId: completion.shopId,
            scanJobId: completion.scanJobId,
            scanTaskId: completion.scanTaskId,
            scanTaskAttemptId: completion.scanTaskAttemptId,
          });
        }

        failedCount += 1;
        continue;
      }

      const normalizedStatus = snapshot.status.toUpperCase();

      if (normalizedStatus === "COMPLETED") {
        const completion = await markAttemptFinishedFromWebhook({
          bulkOperationId,
          bulkOperationStatus: "COMPLETED",
          bulkResultUrl: snapshot.url ?? snapshot.partialDataUrl ?? null,
          finishedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : now,
          errorCode: snapshot.errorCode,
          errorMessage: null,
        });

        if (completion?.shouldEnqueueParse) {
          await enqueueParseBulkToStaging({
            shopId: completion.shopId,
            scanJobId: completion.scanJobId,
            scanTaskId: completion.scanTaskId,
            scanTaskAttemptId: completion.scanTaskAttemptId,
          });
        }

        convergedCount += 1;
      } else if (normalizedStatus === "FAILED" || normalizedStatus === "CANCELED") {
        const completion = await markAttemptFinishedFromWebhook({
          bulkOperationId,
          bulkOperationStatus: normalizedStatus === "CANCELED" ? "CANCELED" : "FAILED",
          bulkResultUrl: snapshot.url ?? snapshot.partialDataUrl ?? null,
          finishedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : now,
          errorCode: snapshot.errorCode,
          errorMessage: normalizedStatus === "CANCELED" ? "BULK_OPERATION_CANCELED" : null,
        });

        if (completion?.shouldEnqueueParse) {
          await enqueueParseBulkToStaging({
            shopId: completion.shopId,
            scanJobId: completion.scanJobId,
            scanTaskId: completion.scanTaskId,
            scanTaskAttemptId: completion.scanTaskAttemptId,
          });
        }

        failedCount += 1;
      } else {
        // CREATED / RUNNING / 其他进行中状态：留待下次巡检，不干预。
        stillRunningCount += 1;
      }
    } catch (error) {
      errorCount += 1;
      logger.error(
        {
          shopId: attempt.shopId,
          scanTaskId: attempt.scanTaskId,
          bulkOperationId,
          err: error,
        },
        "bulk-attempt-reaper.attempt-failed",
      );
    }
  }

  return {
    checkedCount: attempts.length,
    convergedCount,
    stillRunningCount,
    failedCount,
    errorCount,
  };
}
