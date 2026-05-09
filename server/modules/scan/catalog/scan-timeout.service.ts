/**
 * File: server/modules/scan/catalog/scan-timeout.service.ts
 * Purpose: RUNNING 扫描超时兜底服务。
 *          当 scan_job 长时间没有 Redis 进度更新时，将其收敛为 FAILED，
 *          并清理进度缓存与 SCAN 锁，避免页面和互斥锁长期卡在运行中。
 */
import type { ScanResourceType } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import {
  deleteScanProgress,
  getScanProgress,
  getScanProgressKey,
} from "../../../sse/progress-publisher";
import { queueConnection } from "../../../queues/connection";
import { releaseLockByType } from "../../lock/operation-lock.service";
import { RUNNING_SCAN_STALE_TIMEOUT_MS } from "../scan.constants";

const logger = createLogger({ module: "scan-timeout-service" });

const RUNNING_ATTEMPT_STATUSES = [
  "PENDING",
  "RUNNING",
  "READY_TO_PARSE",
  "PARSING",
] as const;

const RUNNING_TASK_STATUSES = ["PENDING", "RUNNING"] as const;
const DEFAULT_SCAN_TIMEOUT_SWEEP_LIMIT = 100;
const SCAN_TIMEOUT_ERROR = "[SCAN_STALE_TIMEOUT] 扫描超过 10 分钟无进度更新，已自动标记为失败";

export interface TimeoutRunningScansResult {
  checkedCount: number;
  timedOutCount: number;
  redisDeletedCount: number;
}

interface RunningScanJobCandidate {
  id: string;
  shopId: string;
  startedAt: Date;
}

interface TimedOutScanJob {
  id: string;
  shopId: string;
  failedResourceTypes: ScanResourceType[];
}

/**
 * 巡检 RUNNING 扫描并处理超过 10 分钟无更新的任务。
 *
 * Redis progress.updatedAt 是优先信号；旧数据没有 updatedAt 时回退到 startedAt，
 * 防止历史 RUNNING 任务永远无法被清理。
 */
export async function timeoutStaleRunningScans(
  options?: {
    now?: Date;
    timeoutMs?: number;
    limit?: number;
  },
): Promise<TimeoutRunningScansResult> {
  const now = options?.now ?? new Date();
  const timeoutMs = options?.timeoutMs ?? RUNNING_SCAN_STALE_TIMEOUT_MS;
  const limit = options?.limit ?? DEFAULT_SCAN_TIMEOUT_SWEEP_LIMIT;
  const cutoffTime = now.getTime() - timeoutMs;

  const candidates = await prisma.scanJob.findMany({
    where: {
      status: "RUNNING",
      startedAt: {
        lte: new Date(cutoffTime),
      },
    },
    orderBy: { startedAt: "asc" },
    take: limit,
    select: {
      id: true,
      shopId: true,
      startedAt: true,
    },
  });

  let timedOutCount = 0;
  let redisDeletedCount = 0;

  for (const candidate of candidates) {
    const lastUpdatedAt = await resolveLastProgressUpdate(candidate);

    if (lastUpdatedAt.getTime() > cutoffTime) {
      continue;
    }

    const timedOutScanJob = await markRunningScanJobTimedOut(candidate.id, now);

    if (!timedOutScanJob) {
      continue;
    }

    timedOutCount += 1;
    redisDeletedCount += await deleteScanProgress(timedOutScanJob.id);
    await releaseLockByType(timedOutScanJob.shopId, "SCAN");

    logger.warn(
      {
        scanJobId: timedOutScanJob.id,
        shopId: timedOutScanJob.shopId,
        lastUpdatedAt,
        failedResourceTypes: timedOutScanJob.failedResourceTypes,
      },
      "scan-timeout.running-scan-marked-failed",
    );
  }

  return {
    checkedCount: candidates.length,
    timedOutCount,
    redisDeletedCount,
  };
}

async function resolveLastProgressUpdate(
  candidate: RunningScanJobCandidate,
): Promise<Date> {
  const progress = await getScanProgress(candidate.id);
  const updatedAt = progress ? await readProgressUpdatedAt(candidate.id) : null;

  if (updatedAt) {
    return updatedAt;
  }

  return candidate.startedAt;
}

async function readProgressUpdatedAt(scanJobId: string): Promise<Date | null> {
  const rawValue = await queueConnection.hget(getScanProgressKey(scanJobId), "updatedAt");

  if (!rawValue) {
    return null;
  }

  const parsedTime = Date.parse(rawValue);
  if (Number.isNaN(parsedTime)) {
    return null;
  }

  return new Date(parsedTime);
}

async function markRunningScanJobTimedOut(
  scanJobId: string,
  finishedAt: Date,
): Promise<TimedOutScanJob | null> {
  return prisma.$transaction(async (tx) => {
    const scanJob = await tx.scanJob.findUnique({
      where: { id: scanJobId },
      select: {
        id: true,
        shopId: true,
        status: true,
        scanTasks: {
          select: {
            id: true,
            resourceType: true,
            status: true,
          },
        },
      },
    });

    if (!scanJob || scanJob.status !== "RUNNING") {
      return null;
    }

    const failedResourceTypes = scanJob.scanTasks
      .filter((task) => task.status !== "SUCCESS")
      .map((task) => task.resourceType);

    const updateResult = await tx.scanJob.updateMany({
      where: {
        id: scanJobId,
        status: "RUNNING",
      },
      data: {
        status: "FAILED",
        publishStatus: "NOT_PUBLISHED",
        failedResourceTypes,
        error: SCAN_TIMEOUT_ERROR,
        finishedAt,
      },
    });

    if (updateResult.count === 0) {
      return null;
    }

    await tx.scanTaskAttempt.updateMany({
      where: {
        scanTaskId: {
          in: scanJob.scanTasks.map((task) => task.id),
        },
        status: {
          in: [...RUNNING_ATTEMPT_STATUSES],
        },
      },
      data: {
        status: "FAILED",
        lastParseError: SCAN_TIMEOUT_ERROR,
        finishedAt,
      },
    });

    await tx.scanTask.updateMany({
      where: {
        scanJobId,
        status: {
          in: [...RUNNING_TASK_STATUSES],
        },
      },
      data: {
        status: "FAILED",
        error: SCAN_TIMEOUT_ERROR,
        finishedAt,
      },
    });

    return {
      id: scanJob.id,
      shopId: scanJob.shopId,
      failedResourceTypes,
    };
  });
}
