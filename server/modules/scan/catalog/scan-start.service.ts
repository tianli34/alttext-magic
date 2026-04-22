/**
 * File: server/modules/scan/catalog/scan-start.service.ts
 * Purpose: scan_start job 协调入口，以及 BULK_OPERATIONS_FINISH 后的补位提交。
 */
import { randomUUID } from "node:crypto";
import type { ScanJobStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "../../../db/prisma.server";
import { enqueueParseBulkToStaging } from "../../../queues/parse-bulk.queue";
import { createLogger } from "../../../utils/logger";
import {
  BULK_SLOT_LOCK_TTL_MS,
  acquireBulkSlotLock,
  releaseBulkSlotLock,
} from "./bulk-slot-lock.server";
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
  lockAcquired: boolean;
  availableSlots: number;
  selectedTaskCount: number;
  submittedCount: number;
  slotExhaustedCount: number;
  failedCount: number;
  skippedCount: number;
}

interface ScanStartServiceDependencies {
  findScanJob(scanJobId: string): Promise<{ id: string; shopId: string } | null>;
  findShopByDomain(shopDomain: string): Promise<{ id: string } | null>;
  getAvailableSlots(shopId: string): Promise<number>;
  getPendingScanTasksOrdered: typeof getPendingScanTasksOrdered;
  submitTask(scanTaskId: string): Promise<BulkSubmitResult>;
  finalizeScanJobIfTerminal(scanJobId: string): Promise<ScanJobStatus | null>;
  getBulkOperationById: typeof getBulkOperationById;
  markAttemptFinishedFromWebhook: typeof markAttemptFinishedFromWebhook;
  enqueueParseBulkToStaging: typeof enqueueParseBulkToStaging;
  acquireBulkSlotLock(
    shopId: string,
    ownerToken: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseBulkSlotLock(shopId: string, ownerToken: string): Promise<boolean>;
}

const defaultDependencies: ScanStartServiceDependencies = {
  async findScanJob(scanJobId) {
    return prisma.scanJob.findUnique({
      where: { id: scanJobId },
      select: {
        id: true,
        shopId: true,
      },
    });
  },
  async findShopByDomain(shopDomain) {
    return prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true },
    });
  },
  getAvailableSlots(shopId) {
    return bulkSlotManager.availableSlots(shopId);
  },
  getPendingScanTasksOrdered,
  submitTask(scanTaskId) {
    return bulkSubmitService.submitTask(scanTaskId);
  },
  finalizeScanJobIfTerminal,
  getBulkOperationById,
  markAttemptFinishedFromWebhook,
  enqueueParseBulkToStaging,
  acquireBulkSlotLock,
  releaseBulkSlotLock,
};

const scanStartServiceDependencies: ScanStartServiceDependencies = {
  ...defaultDependencies,
};

export function setScanStartServiceDependenciesForTests(
  overrides: Partial<ScanStartServiceDependencies>,
): void {
  Object.assign(scanStartServiceDependencies, overrides);
}

export function resetScanStartServiceDependenciesForTests(): void {
  Object.assign(scanStartServiceDependencies, defaultDependencies);
}

function createEmptySubmitResult(
  scanJobId: string,
  shopId: string,
  availableSlots: number,
  lockAcquired: boolean,
): TrySubmitNextBatchResult {
  return {
    scanJobId,
    shopId,
    lockAcquired,
    availableSlots,
    selectedTaskCount: 0,
    submittedCount: 0,
    slotExhaustedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
}

function normalizeBulkTerminalStatus(
  status: string,
): "COMPLETED" | "FAILED" | "CANCELED" {
  const normalizedStatus = status.toUpperCase();

  if (
    normalizedStatus === "COMPLETED" ||
    normalizedStatus === "FAILED" ||
    normalizedStatus === "CANCELED"
  ) {
    return normalizedStatus;
  }

  return "FAILED";
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
  const scanJob = await scanStartServiceDependencies.findScanJob(scanJobId);

  if (!scanJob) {
    logger.warn({ scanJobId }, "scan-start.scan-job-not-found");
    return null;
  }

  const ownerToken = `${scanJobId}:${randomUUID()}`;
  const lockAcquired = await scanStartServiceDependencies.acquireBulkSlotLock(
    scanJob.shopId,
    ownerToken,
    BULK_SLOT_LOCK_TTL_MS,
  );

  if (!lockAcquired) {
    logger.info(
      { scanJobId, shopId: scanJob.shopId },
      "scan-start.try-submit-lock-skipped",
    );
    return createEmptySubmitResult(scanJobId, scanJob.shopId, 0, false);
  }

  try {
    const availableSlots = await scanStartServiceDependencies.getAvailableSlots(
      scanJob.shopId,
    );
    if (availableSlots <= 0) {
      logger.info(
        { scanJobId, shopId: scanJob.shopId },
        "scan-start.no-available-slots",
      );
      return createEmptySubmitResult(scanJobId, scanJob.shopId, 0, true);
    }

    const pendingTasks = await scanStartServiceDependencies.getPendingScanTasksOrdered(
      scanJobId,
      availableSlots,
    );
    if (pendingTasks.length === 0) {
      await scanStartServiceDependencies.finalizeScanJobIfTerminal(scanJobId);
      return createEmptySubmitResult(
        scanJobId,
        scanJob.shopId,
        availableSlots,
        true,
      );
    }

    const results = await Promise.all(
      pendingTasks.map((task) => scanStartServiceDependencies.submitTask(task.id)),
    );

    const summary = summarizeSubmitResults(results);
    await scanStartServiceDependencies.finalizeScanJobIfTerminal(scanJobId);

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
      lockAcquired: true,
      availableSlots,
      selectedTaskCount: pendingTasks.length,
      ...summary,
    };
  } finally {
    await scanStartServiceDependencies.releaseBulkSlotLock(
      scanJob.shopId,
      ownerToken,
    );
  }
}

export async function processScanStartJob(scanJobId: string): Promise<void> {
  await trySubmitNextBatch(scanJobId);
}

export async function handleBulkOperationsFinishWebhook(input: {
  shopDomain: string;
  payload: unknown;
}): Promise<void> {
  const payload = bulkFinishWebhookPayloadSchema.parse(input.payload);
  const shop = await scanStartServiceDependencies.findShopByDomain(
    input.shopDomain,
  );

  if (!shop) {
    logger.warn(
      { shopDomain: input.shopDomain },
      "scan-start.bulk-finish-shop-not-found",
    );
    return;
  }

  const bulkOperation = await scanStartServiceDependencies.getBulkOperationById(
    shop.id,
    payload.admin_graphql_api_id,
  );

  const normalizedStatus = normalizeBulkTerminalStatus(
    bulkOperation?.status ?? payload.status,
  );
  const finishedAt = bulkOperation?.completedAt
    ? new Date(bulkOperation.completedAt)
    : payload.completed_at
      ? new Date(payload.completed_at)
      : new Date();

  const completion = await scanStartServiceDependencies.markAttemptFinishedFromWebhook({
    bulkOperationId: payload.admin_graphql_api_id,
    bulkOperationStatus: normalizedStatus,
    bulkResultUrl: bulkOperation?.url ?? bulkOperation?.partialDataUrl ?? null,
    finishedAt,
    errorCode: bulkOperation?.errorCode ?? payload.error_code ?? null,
    errorMessage:
      normalizedStatus === "COMPLETED" ? null : "Bulk operation finished with terminal error",
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

  if (completion.shouldEnqueueParse) {
    await scanStartServiceDependencies.enqueueParseBulkToStaging({
      shopId: completion.shopId,
      scanJobId: completion.scanJobId,
      scanTaskId: completion.scanTaskId,
      scanTaskAttemptId: completion.scanTaskAttemptId,
    });
  }

  if (completion.alreadyTerminal) {
    return;
  }

  await trySubmitNextBatch(completion.scanJobId);
  await scanStartServiceDependencies.finalizeScanJobIfTerminal(
    completion.scanJobId,
  );
}
