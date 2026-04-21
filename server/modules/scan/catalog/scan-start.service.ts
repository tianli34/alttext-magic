/**
 * File: server/modules/scan/catalog/scan-start.service.ts
 * Purpose: scan_start job 协调入口，以及 BULK_OPERATIONS_FINISH 后的补位提交。
 */
import { z } from "zod";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { bulkSlotManager } from "./bulk-slot-manager.service";
import { bulkSubmitService, type BulkSubmitResult } from "./bulk-submit.service";
import { finalizeScanJobIfTerminal, getPendingScanTasksOrdered } from "./scan-task.service";
import { getBulkOperationById } from "./shopify-bulk.client.server";
import { markAttemptFinishedFromWebhook } from "./scan-task-attempt.service";

const logger = createLogger({ module: "scan-start-service" });

const bulkFinishWebhookPayloadSchema = z.object({
  admin_graphql_api_id: z.string().min(1),
  status: z.string().min(1),
  error_code: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

export interface TrySubmitNextBatchResult {
  scanJobId: string;
  shopId: string;
  availableSlots: number;
  selectedTaskCount: number;
  submittedCount: number;
  slotExhaustedCount: number;
  failedCount: number;
  skippedCount: number;
}

function summarizeSubmitResults(results: BulkSubmitResult[]) {
  return {
    submittedCount: results.filter((result) => result.status === "submitted").length,
    slotExhaustedCount: results.filter((result) => result.status === "slot_exhausted").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
  };
}

export async function trySubmitNextBatch(
  scanJobId: string,
): Promise<TrySubmitNextBatchResult | null> {
  const scanJob = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
    select: {
      id: true,
      shopId: true,
    },
  });

  if (!scanJob) {
    logger.warn({ scanJobId }, "scan-start.scan-job-not-found");
    return null;
  }

  const availableSlots = await bulkSlotManager.availableSlots(scanJob.shopId);
  if (availableSlots <= 0) {
    logger.info(
      { scanJobId, shopId: scanJob.shopId },
      "scan-start.no-available-slots",
    );
    return {
      scanJobId,
      shopId: scanJob.shopId,
      availableSlots: 0,
      selectedTaskCount: 0,
      submittedCount: 0,
      slotExhaustedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
  }

  const pendingTasks = await getPendingScanTasksOrdered(scanJobId, availableSlots);
  if (pendingTasks.length === 0) {
    await finalizeScanJobIfTerminal(scanJobId);
    return {
      scanJobId,
      shopId: scanJob.shopId,
      availableSlots,
      selectedTaskCount: 0,
      submittedCount: 0,
      slotExhaustedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
  }

  const results = await Promise.all(
    pendingTasks.map((task) => bulkSubmitService.submitTask(task.id)),
  );

  const summary = summarizeSubmitResults(results);
  await finalizeScanJobIfTerminal(scanJobId);

  logger.info(
    {
      scanJobId,
      shopId: scanJob.shopId,
      availableSlots,
      selectedTaskCount: pendingTasks.length,
      ...summary,
    },
    "scan-start.try-submit-next-batch",
  );

  return {
    scanJobId,
    shopId: scanJob.shopId,
    availableSlots,
    selectedTaskCount: pendingTasks.length,
    ...summary,
  };
}

export async function processScanStartJob(scanJobId: string): Promise<void> {
  await trySubmitNextBatch(scanJobId);
}

export async function handleBulkOperationsFinishWebhook(input: {
  shopDomain: string;
  payload: unknown;
}): Promise<void> {
  const payload = bulkFinishWebhookPayloadSchema.parse(input.payload);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: input.shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn(
      { shopDomain: input.shopDomain },
      "scan-start.bulk-finish-shop-not-found",
    );
    return;
  }

  const bulkOperation = await getBulkOperationById(
    shop.id,
    payload.admin_graphql_api_id,
  );

  const normalizedStatus = (bulkOperation?.status ?? payload.status).toUpperCase();
  const finishedAt = bulkOperation?.completedAt
    ? new Date(bulkOperation.completedAt)
    : payload.completed_at
      ? new Date(payload.completed_at)
      : new Date();

  const completion = await markAttemptFinishedFromWebhook({
    bulkOperationId: payload.admin_graphql_api_id,
    attemptStatus: normalizedStatus === "COMPLETED" ? "READY_TO_PARSE" : "FAILED",
    taskStatus: normalizedStatus === "COMPLETED" ? "SUCCESS" : "FAILED",
    bulkResultUrl: bulkOperation?.url ?? bulkOperation?.partialDataUrl ?? null,
    finishedAt,
    errorMessage:
      normalizedStatus === "COMPLETED"
        ? null
        : bulkOperation?.errorCode ?? payload.error_code ?? "BULK_OPERATION_FAILED",
  });

  logger.info(
    {
      shopId: shop.id,
      bulkOperationId: payload.admin_graphql_api_id,
      status: normalizedStatus,
      completedAt: finishedAt.toISOString(),
      bulkResultUrl: bulkOperation?.url ?? bulkOperation?.partialDataUrl ?? null,
      errorCode: bulkOperation?.errorCode ?? payload.error_code ?? null,
    },
    "scan-start.bulk-operation-finished",
  );

  if (!completion) {
    return;
  }

  await trySubmitNextBatch(completion.scanJobId);
  await finalizeScanJobIfTerminal(completion.scanJobId);
}
