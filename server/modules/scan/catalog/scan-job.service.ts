/**
 * File: server/modules/scan/catalog/scan-job.service.ts
 * Purpose: scan_job 创建与状态查询服务。
 *          - createScanJobWithTasks：在单个 Prisma 事务内完成 scan_job + scan_task 的原子创建。
 *          - getScanStatus：聚合 scan_job 状态、task 列表（含最新 attempt）和 Redis 进度。
 */
import type { PrismaClient, ScanResourceType } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { getScanProgress, setScanProgressStatus } from "../../../sse/progress-publisher";
import { releaseLockByType } from "../../lock/operation-lock.service";
import { removeQueuedScanStartJob } from "../../../queues/scan-start.queue";
import type {
  CreateScanJobParams,
  CreateScanJobResult,
  ScanTaskCreateInfo,
  ScanStatusResponse,
  ScanStatusJob,
  ScanStatusTask,
  ScanStatusAttempt,
} from "../scan.types";

const logger = createLogger({ module: "scan-job-service" });

type TransactionClient = Parameters<PrismaClient["$transaction"]>[0] extends (
  tx: infer T,
) => Promise<unknown>
  ? T
  : never;

/**
 * 在单个事务内创建 scan_job 和按 scope 对应的 scan_task。
 *
 * 事务保证：
 * - scan_job 和 scan_task 原子写入
 * - scan_task 通过 @@unique([scanJobId, resourceType]) 约束避免重复
 *
 * @param params 创建参数，包含 shopId、scopeFlags、noticeVersion、enabledResourceTypes
 * @returns 创建结果，包含 scanJobId、status 和 tasks 列表
 */
export async function createScanJobWithTasks(
  params: CreateScanJobParams,
): Promise<CreateScanJobResult> {
  const { shopId, scopeFlags, noticeVersion, enabledResourceTypes } = params;

  return prisma.$transaction(async (tx: TransactionClient) => {
    // 1. 创建 scan_job
    const scanJob = await tx.scanJob.create({
      data: {
        shopId,
        scopeFlags: scopeFlags as Record<string, boolean>,
        noticeVersion,
        status: "RUNNING",
        publishStatus: "PENDING",
      },
      select: { id: true, status: true },
    });

    // 2. 按 enabledResourceTypes 创建 scan_task
    const tasks: ScanTaskCreateInfo[] = await Promise.all(
      enabledResourceTypes.map((resourceType: ScanResourceType) =>
        tx.scanTask
          .create({
            data: {
              shopId,
              scanJobId: scanJob.id,
              resourceType,
              status: "PENDING",
            },
            select: { id: true, resourceType: true },
          })
          .then((t) => ({ id: t.id, resourceType: t.resourceType })),
      ),
    );

    logger.info(
      {
        shopId,
        scanJobId: scanJob.id,
        taskCount: tasks.length,
        resourceTypes: enabledResourceTypes,
      },
      "scan_job + scan_tasks created in transaction",
    );

    return {
      scanJobId: scanJob.id,
      scanJobStatus: scanJob.status,
      tasks,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  辅助：构建最新 attempt                                              */
/* ------------------------------------------------------------------ */

/** Prisma 查询返回的 attempt 原始行 */
interface AttemptRow {
  id: string;
  attemptNo: number;
  status: string;
  bulkOperationId: string | null;
  parsedRows: number;
  lastParseError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * 从 attempt 列表中提取最新（attemptNo 最大）的 attempt 并转换为 DTO。
 * attempts 按 attemptNo ASC 排序，取最后一个。
 */
function buildLatestAttempt(
  attempts: AttemptRow[],
): ScanStatusAttempt | null {
  if (attempts.length === 0) return null;
  const latest = attempts[attempts.length - 1];
  return {
    id: latest.id,
    attemptNo: latest.attemptNo,
    status: latest.status as ScanStatusAttempt["status"],
    bulkOperationId: latest.bulkOperationId,
    parsedRows: latest.parsedRows,
    lastParseError: latest.lastParseError,
    startedAt: latest.startedAt.toISOString(),
    finishedAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/*  主函数：获取扫描状态                                                */
/* ------------------------------------------------------------------ */

/**
 * 获取指定 scan_job 的完整状态，包括 task 列表、最新 attempt 和 Redis 进度。
 *
 * 并行查询：
 *   1. scan_job 基础信息（含 shop 的 lastPublishedAt）
 *   2. scan_task 列表（含最新 attempt）
 *   3. Redis 进度摘要
 *
 * @param scanJobId - scan_job 主键
 * @param shopId    - 店铺内部 ID（用于校验归属）
 * @returns ScanStatusResponse，不存在时返回 null
 */
export async function getScanStatus(
  scanJobId: string,
  shopId: string,
): Promise<ScanStatusResponse | null> {
  // 1. 并行查询 scan_job + tasks + Redis 进度
  const [scanJob, tasksWithAttempts, progress] = await Promise.all([
    // scan_job 基础信息
    prisma.scanJob.findUnique({
      where: { id: scanJobId },
      select: {
        id: true,
        shopId: true,
        status: true,
        publishStatus: true,
        scopeFlags: true,
        successfulResourceTypes: true,
        failedResourceTypes: true,
        startedAt: true,
        finishedAt: true,
        publishedAt: true,
        error: true,
        shop: {
          select: { lastPublishedAt: true },
        },
      },
    }),
    // scan_task 列表（按 resourceType 排序），每个 task 含 attempts（按 attemptNo ASC）
    prisma.scanTask.findMany({
      where: { scanJobId },
      orderBy: { resourceType: "asc" },
      select: {
        id: true,
        resourceType: true,
        status: true,
        currentAttemptNo: true,
        maxParseAttempts: true,
        startedAt: true,
        finishedAt: true,
        error: true,
        attempts: {
          orderBy: { attemptNo: "asc" },
          select: {
            id: true,
            attemptNo: true,
            status: true,
            bulkOperationId: true,
            parsedRows: true,
            lastParseError: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    }),
    // Redis 进度摘要（键过期后返回 null）
    getScanProgress(scanJobId),
  ]);

  // 2. scan_job 不存在或不属于当前 shop
  if (!scanJob) {
    return null;
  }

  if (scanJob.shopId !== shopId) {
    logger.warn({ scanJobId, shopId }, "Scan job does not belong to shop");
    return null;
  }

  // 3. 构建 ScanStatusJob
  const scanJobDto: ScanStatusJob = {
    scanJobId: scanJob.id,
    status: scanJob.status,
    publishStatus: scanJob.publishStatus,
    scopeFlags: scanJob.scopeFlags as Record<string, boolean>,
    successfulResourceTypes: scanJob.successfulResourceTypes as string[],
    failedResourceTypes: scanJob.failedResourceTypes as string[],
    startedAt: scanJob.startedAt.toISOString(),
    finishedAt: scanJob.finishedAt ? scanJob.finishedAt.toISOString() : null,
    publishedAt: scanJob.publishedAt ? scanJob.publishedAt.toISOString() : null,
    error: scanJob.error,
  };

  // 4. 构建 ScanStatusTask 列表
  const taskDtos: ScanStatusTask[] = tasksWithAttempts.map((task) => ({
    id: task.id,
    resourceType: task.resourceType,
    status: task.status,
    currentAttemptNo: task.currentAttemptNo,
    maxParseAttempts: task.maxParseAttempts,
    startedAt: task.startedAt.toISOString(),
    finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
    error: task.error,
    latestAttempt: buildLatestAttempt(task.attempts),
  }));

  // 5. lastPublishedAt
  const lastPublishedAt = scanJob.shop.lastPublishedAt
    ? scanJob.shop.lastPublishedAt.toISOString()
    : null;

  return {
    scanJob: scanJobDto,
    tasks: taskDtos,
    progress,
    lastPublishedAt,
  };
}

export async function stopPendingScanJob(
  scanJobId: string,
  shopId: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" | "NOT_RUNNING" | "ALREADY_STARTED" }
> {
  const [scanJob, tasks] = await Promise.all([
    prisma.scanJob.findUnique({
      where: { id: scanJobId },
      select: {
        id: true,
        shopId: true,
        status: true,
      },
    }),
    prisma.scanTask.findMany({
      where: { scanJobId },
      select: {
        id: true,
        resourceType: true,
        status: true,
        currentAttemptNo: true,
      },
    }),
  ]);

  if (!scanJob || scanJob.shopId !== shopId) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (scanJob.status !== "RUNNING") {
    return { ok: false, reason: "NOT_RUNNING" };
  }

  const canStop = tasks.length > 0 &&
    tasks.every((task) => task.status === "PENDING" && task.currentAttemptNo === 0);

  if (!canStop) {
    return { ok: false, reason: "ALREADY_STARTED" };
  }

  const now = new Date();
  const errorMessage = "用户手动停止了尚未开始执行的扫描";

  await removeQueuedScanStartJob(scanJobId);

  await prisma.$transaction(async (tx) => {
    await tx.scanTask.updateMany({
      where: {
        scanJobId,
        status: "PENDING",
      },
      data: {
        status: "FAILED",
        error: errorMessage,
        finishedAt: now,
      },
    });

    await tx.scanJob.update({
      where: { id: scanJobId },
      data: {
        status: "FAILED",
        publishStatus: "NOT_PUBLISHED",
        finishedAt: now,
        failedResourceTypes: tasks.map((task) => task.resourceType),
        error: errorMessage,
      },
    });
  });

  await releaseLockByType(shopId, "SCAN");
  await setScanProgressStatus(scanJobId, "FAILED", "failed", "扫描已停止");

  logger.info({ scanJobId, shopId }, "scan-job.pending-stopped");

  return { ok: true };
}
