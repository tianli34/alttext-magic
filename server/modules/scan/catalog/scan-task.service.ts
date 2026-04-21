/**
 * File: server/modules/scan/catalog/scan-task.service.ts
 * Purpose: scan_task 查询与终态收敛服务。
 */
import type { ScanJobStatus, ScanResourceType } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { compareScanResourcePriority } from "./bulk-query-builder";

const logger = createLogger({ module: "scan-task-service" });

export interface PendingScanTaskRow {
  id: string;
  scanJobId: string;
  shopId: string;
  resourceType: ScanResourceType;
  currentAttemptNo: number;
}

export async function getPendingScanTasksOrdered(
  scanJobId: string,
  limit: number,
): Promise<PendingScanTaskRow[]> {
  const tasks = await prisma.scanTask.findMany({
    where: {
      scanJobId,
      status: "PENDING",
    },
    select: {
      id: true,
      scanJobId: true,
      shopId: true,
      resourceType: true,
      currentAttemptNo: true,
    },
  });

  return tasks
    .sort((left, right) =>
      compareScanResourcePriority(left.resourceType, right.resourceType),
    )
    .slice(0, limit);
}

export async function finalizeScanJobIfTerminal(
  scanJobId: string,
): Promise<ScanJobStatus | null> {
  const tasks = await prisma.scanTask.findMany({
    where: { scanJobId },
    select: {
      status: true,
      resourceType: true,
    },
  });

  if (tasks.length === 0) {
    return null;
  }

  const hasPending = tasks.some((task) => task.status === "PENDING");
  const hasRunning = tasks.some((task) => task.status === "RUNNING");

  if (hasPending || hasRunning) {
    return null;
  }

  const successTasks = tasks.filter((task) => task.status === "SUCCESS");
  const failedTasks = tasks.filter((task) => task.status === "FAILED");

  let nextStatus: ScanJobStatus;
  if (successTasks.length === tasks.length) {
    nextStatus = "SUCCESS";
  } else if (successTasks.length > 0 && failedTasks.length > 0) {
    nextStatus = "PARTIAL_SUCCESS";
  } else {
    nextStatus = "FAILED";
  }

  await prisma.scanJob.update({
    where: { id: scanJobId },
    data: {
      status: nextStatus,
      finishedAt: new Date(),
      successfulResourceTypes: successTasks.map((task) => task.resourceType),
      failedResourceTypes: failedTasks.map((task) => task.resourceType),
    },
  });

  logger.info(
    {
      scanJobId,
      status: nextStatus,
      successCount: successTasks.length,
      failedCount: failedTasks.length,
    },
    "scan-task.scan-job-finalized",
  );

  return nextStatus;
}
