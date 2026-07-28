/**
 * File: server/modules/scan/catalog/scan-task-attempt.service.ts
 * Purpose: scan_task_attempt 预留、提交确认、释放与 webhook 收敛服务。
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "scan-task-attempt-service" });

export interface ReservedScanTaskAttempt {
  attemptId: string;
  attemptNo: number;
  scanTaskId: string;
  scanJobId: string;
  shopId: string;
  resourceType: string;
}

export async function reserveNextScanTaskAttempt(
  scanTaskId: string,
): Promise<ReservedScanTaskAttempt | null> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.scanTask.findUnique({
      where: { id: scanTaskId },
      select: {
        id: true,
        shopId: true,
        scanJobId: true,
        resourceType: true,
        status: true,
        currentAttemptNo: true,
      },
    });

    if (!task || task.status !== "PENDING") {
      return null;
    }

    const nextAttemptNo = task.currentAttemptNo + 1;

    const attempt = await tx.scanTaskAttempt.create({
      data: {
        shopId: task.shopId,
        scanTaskId: task.id,
        attemptNo: nextAttemptNo,
        status: "PENDING",
      },
      select: {
        id: true,
      },
    });

    await tx.scanTask.update({
      where: { id: task.id },
      data: {
        status: "RUNNING",
        currentAttemptNo: nextAttemptNo,
        error: null,
        finishedAt: null,
      },
    });

    return {
      attemptId: attempt.id,
      attemptNo: nextAttemptNo,
      scanTaskId: task.id,
      scanJobId: task.scanJobId,
      shopId: task.shopId,
      resourceType: task.resourceType,
    };
  });
}

export async function markAttemptSubmitted(input: {
  attemptId: string;
  scanTaskId: string;
  bulkOperationId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.scanTaskAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: "RUNNING",
        bulkOperationId: input.bulkOperationId,
      },
    });

    await tx.scanTask.update({
      where: { id: input.scanTaskId },
      data: {
        status: "RUNNING",
      },
    });
  });
}

export async function releaseReservedAttempt(input: {
  attemptId: string;
  scanTaskId: string;
  previousAttemptNo: number;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.scanTaskAttempt.delete({
      where: { id: input.attemptId },
    });

    await tx.scanTask.update({
      where: { id: input.scanTaskId },
      data: {
        status: "PENDING",
        currentAttemptNo: input.previousAttemptNo,
        finishedAt: null,
        error: null,
      },
    });
  });
}

export async function failAttemptSubmission(input: {
  attemptId: string;
  scanTaskId: string;
  errorMessage: string;
}): Promise<void> {
  const finishedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.scanTaskAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: "FAILED",
        lastParseError: input.errorMessage,
        finishedAt,
      },
    });

    await tx.scanTask.update({
      where: { id: input.scanTaskId },
      data: {
        status: "FAILED",
        error: input.errorMessage,
        finishedAt,
      },
    });
  });
}

export async function markAttemptFinishedFromWebhook(input: {
  bulkOperationId: string;
  bulkOperationStatus: "COMPLETED" | "FAILED" | "CANCELED";
  bulkResultUrl: string | null;
  finishedAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * 查不到 attempt 时是否静默跳过 warn。
   * 调用方做竞态兜底重试时, 首查传 true 以避免正常的竞态窗口误报 warn,
   * 重试仍查不到再按默认(false)打 warn 暴露真正的无关/脏数据事件。
   */
  silentNotFound?: boolean;
}): Promise<{
  scanJobId: string;
  scanTaskId: string;
  scanTaskAttemptId: string;
  shopId: string;
  alreadyTerminal: boolean;
  shouldEnqueueParse: boolean;
} | null> {
  const attempt = await prisma.scanTaskAttempt.findUnique({
    where: { bulkOperationId: input.bulkOperationId },
    select: {
      id: true,
      shopId: true,
      status: true,
      scanTaskId: true,
      scanTask: {
        select: {
          scanJobId: true,
        },
      },
    },
  });

  if (!attempt) {
    if (!input.silentNotFound) {
      logger.warn(
        { bulkOperationId: input.bulkOperationId },
        "scan-task-attempt.bulk-operation-not-found",
      );
    }
    return null;
  }

  if (["READY_TO_PARSE", "SUCCESS", "FAILED"].includes(attempt.status)) {
    logger.info(
      {
        bulkOperationId: input.bulkOperationId,
        attemptId: attempt.id,
        attemptStatus: attempt.status,
      },
      "scan-task-attempt.bulk-operation-already-terminal",
    );

    return {
      scanJobId: attempt.scanTask.scanJobId,
      scanTaskId: attempt.scanTaskId,
      scanTaskAttemptId: attempt.id,
      shopId: attempt.shopId,
      alreadyTerminal: true,
      shouldEnqueueParse: false,
    };
  }

  const attemptStatus =
    input.bulkOperationStatus === "COMPLETED" ? "READY_TO_PARSE" : "FAILED";
  const taskStatus =
    input.bulkOperationStatus === "COMPLETED" ? "RUNNING" : "FAILED";
  const composedErrorMessage = [
    input.bulkOperationStatus === "CANCELED" ? "BULK_OPERATION_CANCELED" : null,
    input.errorCode,
    input.errorMessage,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ") || null;

  await prisma.$transaction(async (tx) => {
    await tx.scanTaskAttempt.update({
      where: { id: attempt.id },
      data: {
        status: attemptStatus,
        bulkResultUrl: input.bulkResultUrl,
        resultUrlFetchedAt: input.bulkResultUrl ? new Date() : null,
        lastParseError: composedErrorMessage,
        finishedAt: input.finishedAt,
      },
    });

    await tx.scanTask.update({
      where: { id: attempt.scanTaskId },
      data: {
        status: taskStatus,
        successfulAttemptId: null,
        error: taskStatus === "FAILED" ? composedErrorMessage : null,
        finishedAt: taskStatus === "FAILED" ? input.finishedAt : null,
      },
    });
  });

  return {
    scanJobId: attempt.scanTask.scanJobId,
    scanTaskId: attempt.scanTaskId,
    scanTaskAttemptId: attempt.id,
    shopId: attempt.shopId,
    alreadyTerminal: false,
    shouldEnqueueParse: input.bulkOperationStatus === "COMPLETED",
  };
}
