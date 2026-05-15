import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { compareScanResourcePriority } from "./bulk-query-builder";
const logger = createLogger({ module: "scan-task-service" });
export async function getPendingScanTasksOrdered(scanJobId, limit) {
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
        .sort((left, right) => compareScanResourcePriority(left.resourceType, right.resourceType))
        .slice(0, limit);
}
export async function finalizeScanJobIfTerminal(scanJobId) {
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
    let nextStatus;
    if (successTasks.length === tasks.length) {
        nextStatus = "SUCCESS";
    }
    else if (successTasks.length > 0 && failedTasks.length > 0) {
        nextStatus = "PARTIAL_SUCCESS";
    }
    else {
        nextStatus = "FAILED";
    }
    const nextPublishStatus = nextStatus === "FAILED" ? "NOT_PUBLISHED" : "PENDING";
    const updateResult = await prisma.scanJob.updateMany({
        where: {
            id: scanJobId,
            status: "RUNNING",
        },
        data: {
            status: nextStatus,
            publishStatus: nextPublishStatus,
            finishedAt: new Date(),
            successfulResourceTypes: successTasks.map((task) => task.resourceType),
            failedResourceTypes: failedTasks.map((task) => task.resourceType),
        },
    });
    if (updateResult.count === 0) {
        const existing = await prisma.scanJob.findUnique({
            where: { id: scanJobId },
            select: {
                status: true,
                publishStatus: true,
            },
        });
        if (!existing) {
            return null;
        }
        return {
            status: existing.status,
            publishStatus: existing.publishStatus,
            transitioned: false,
        };
    }
    logger.info({
        scanJobId,
        status: nextStatus,
        successCount: successTasks.length,
        failedCount: failedTasks.length,
    }, "scan-task.scan-job-finalized");
    return {
        status: nextStatus,
        publishStatus: nextPublishStatus,
        transitioned: true,
    };
}
export async function markScanTaskSucceeded(input) {
    await prisma.scanTask.update({
        where: { id: input.scanTaskId },
        data: {
            status: "SUCCESS",
            successfulAttemptId: input.scanTaskAttemptId,
            error: null,
            finishedAt: input.finishedAt,
        },
    });
}
export async function markScanTaskFailed(input) {
    await prisma.scanTask.update({
        where: { id: input.scanTaskId },
        data: {
            status: "FAILED",
            error: input.errorMessage,
            finishedAt: input.finishedAt,
        },
    });
}
export async function resetScanTaskToPendingForRetry(input) {
    await prisma.scanTask.update({
        where: { id: input.scanTaskId },
        data: {
            status: "PENDING",
            successfulAttemptId: null,
            error: null,
            finishedAt: null,
        },
    });
}
