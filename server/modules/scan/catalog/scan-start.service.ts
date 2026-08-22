/**
 * File: server/modules/scan/catalog/scan-start.service.ts
 * Purpose: scan_start job 协调入口: 槽位锁内选取 pending task 并提交 Shopify Bulk Query。
 * BULK_OPERATIONS_FINISH 的 webhook 业务处理见 bulk-finish.service.ts。
 */
import { randomUUID } from "node:crypto";
import type { ScanJobStatus } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import {
  BULK_SLOT_LOCK_TTL_MS,
  acquireBulkSlotLock,
  releaseBulkSlotLock,
} from "./bulk-slot-lock.server";
import { bulkSlotManager } from "./bulk-slot-manager.service";
import { bulkSubmitService, type BulkSubmitResult } from "./bulk-submit.service";
import { getPendingScanTasksOrdered } from "./scan-task.service";
import { reconcileScanJobLifecycle } from "./scan-lifecycle.service";
import { updateScanProgressPhase } from "../../../sse/progress-publisher";
import { SCAN_PHASE } from "../scan.constants";

const logger = createLogger({ module: "scan-start-service" });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 同一 shop 的多个 Bulk 查询并行提交时, 对相邻请求做错峰, 降低瞬时连接突发
 * （避免 Shopify 在连接层对超额并发做 shedding, 表现为偶发 connect timeout）。
 */
const BULK_SUBMIT_STAGGER_BASE_MS = 60;

/** 第 index 个任务在批量提交中错开 index * 基数 + 随机抖动, 抖动上限 40ms 避免规律性。 */
function staggerForIndex(index: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 40);
  return delay(index * BULK_SUBMIT_STAGGER_BASE_MS + jitter);
}

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
  getAvailableSlots(shopId: string): Promise<number>;
  getPendingScanTasksOrdered: typeof getPendingScanTasksOrdered;
  submitTask(scanTaskId: string): Promise<BulkSubmitResult>;
  reconcileScanJobLifecycle: typeof reconcileScanJobLifecycle;
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
  getAvailableSlots(shopId) {
    return bulkSlotManager.availableSlots(shopId);
  },
  getPendingScanTasksOrdered,
  submitTask(scanTaskId) {
    return bulkSubmitService.submitTask(scanTaskId);
  },
  reconcileScanJobLifecycle,
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

  const jobLogger = logger.withContext({
    batch_id: scanJobId,
  });

  const ownerToken = `${scanJobId}:${randomUUID()}`;
  const lockAcquired = await scanStartServiceDependencies.acquireBulkSlotLock(
    scanJob.shopId,
    ownerToken,
    BULK_SLOT_LOCK_TTL_MS,
  );

  if (!lockAcquired) {
    jobLogger.info(
      { shopId: scanJob.shopId },
      "scan-start.try-submit-lock-skipped",
    );
    return createEmptySubmitResult(scanJobId, scanJob.shopId, 0, false);
  }

  try {
    const availableSlots = await scanStartServiceDependencies.getAvailableSlots(
      scanJob.shopId,
    );
    if (availableSlots <= 0) {
      jobLogger.info(
        { shopId: scanJob.shopId },
        "scan-start.no-available-slots",
      );
      return createEmptySubmitResult(scanJobId, scanJob.shopId, 0, true);
    }

    const pendingTasks = await scanStartServiceDependencies.getPendingScanTasksOrdered(
      scanJobId,
      availableSlots,
    );
    if (pendingTasks.length === 0) {
      await scanStartServiceDependencies.reconcileScanJobLifecycle({
        scanJobId,
        shopId: scanJob.shopId,
      });
      return createEmptySubmitResult(
        scanJobId,
        scanJob.shopId,
        availableSlots,
        true,
      );
    }

    const results = await Promise.all(
      pendingTasks.map((task, index) =>
        staggerForIndex(index).then(() =>
          scanStartServiceDependencies.submitTask(task.id),
        ),
      ),
    );

    const summary = summarizeSubmitResults(results);
    await scanStartServiceDependencies.reconcileScanJobLifecycle({
      scanJobId,
      shopId: scanJob.shopId,
    });

    jobLogger.info(
      {
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

/**
 * scan_start 作业的完整编排: 提交批量查询后更新 Redis 进度阶段。
 * worker 处理器只调用本入口, 不直接触碰进度发布。
 */
export async function submitNextBatchAndNotify(
  scanJobId: string,
): Promise<TrySubmitNextBatchResult | null> {
  const result = await trySubmitNextBatch(scanJobId);

  // 批量查询已提交，更新进度阶段
  await updateScanProgressPhase(
    scanJobId,
    SCAN_PHASE.BULK_SUBMITTED,
    "批量查询已提交，等待 Shopify 返回数据…",
  );

  return result;
}

