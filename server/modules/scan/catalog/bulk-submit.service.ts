/**
 * File: server/modules/scan/catalog/bulk-submit.service.ts
 * Purpose: 提交单个 scan_task 对应的 Shopify Bulk Query，并负责 attempt 落库。
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { buildBulkQueryByResourceType } from "./bulk-query-builder";
import {
  failAttemptSubmission,
  markAttemptSubmitted,
  releaseReservedAttempt,
  reserveNextScanTaskAttempt,
} from "./scan-task-attempt.service";
import {
  runBulkOperationQuery,
  type ShopifyBulkUserError,
} from "./shopify-bulk.client.server";

const logger = createLogger({ module: "bulk-submit-service" });

export type BulkSubmitResult =
  | { status: "submitted"; taskId: string; attemptId: string; bulkOperationId: string }
  | { status: "slot_exhausted"; taskId: string }
  | { status: "skipped"; taskId: string }
  | { status: "failed"; taskId: string; errorMessage: string };

function formatUserErrors(userErrors: ShopifyBulkUserError[]): string {
  return userErrors
    .map((error) => {
      const code = error.code ? `[${error.code}] ` : "";
      return `${code}${error.message}`;
    })
    .join("; ");
}

function isConcurrentLimitError(userErrors: ShopifyBulkUserError[]): boolean {
  return userErrors.some((error) => {
    const code = error.code?.toUpperCase();
    const message = error.message.toUpperCase();
    return (
      code === "MAX_CONCURRENT_LIMIT_EXCEEDED" ||
      code === "LIMIT_REACHED" ||
      message.includes("MAX_CONCURRENT_LIMIT_EXCEEDED") ||
      (message.includes("CONCURRENT") && message.includes("LIMIT"))
    );
  });
}

export class BulkSubmitService {
  async submitTask(scanTaskId: string): Promise<BulkSubmitResult> {
    const task = await prisma.scanTask.findUnique({
      where: { id: scanTaskId },
      select: {
        id: true,
        shopId: true,
        scanJobId: true,
        resourceType: true,
      },
    });

    if (!task) {
      return {
        status: "failed",
        taskId: scanTaskId,
        errorMessage: `Scan task not found: ${scanTaskId}`,
      };
    }

    const reservedAttempt = await reserveNextScanTaskAttempt(scanTaskId);
    if (!reservedAttempt) {
      return { status: "skipped", taskId: scanTaskId };
    }

    const bulkQuery = buildBulkQueryByResourceType(task.resourceType);

    try {
      const result = await runBulkOperationQuery(task.shopId, bulkQuery);

      if (result.userErrors.length > 0) {
        if (isConcurrentLimitError(result.userErrors)) {
          await releaseReservedAttempt({
            attemptId: reservedAttempt.attemptId,
            scanTaskId: reservedAttempt.scanTaskId,
            previousAttemptNo: reservedAttempt.attemptNo - 1,
          });

          logger.warn(
            {
              shopId: task.shopId,
              scanJobId: task.scanJobId,
              taskId: task.id,
              resourceType: task.resourceType,
              userErrors: result.userErrors,
            },
            "bulk-submit.concurrent-limit-exceeded",
          );

          return { status: "slot_exhausted", taskId: task.id };
        }

        const errorMessage = formatUserErrors(result.userErrors);
        await failAttemptSubmission({
          attemptId: reservedAttempt.attemptId,
          scanTaskId: reservedAttempt.scanTaskId,
          errorMessage,
        });

        logger.error(
          {
            shopId: task.shopId,
            scanJobId: task.scanJobId,
            taskId: task.id,
            resourceType: task.resourceType,
            userErrors: result.userErrors,
          },
          "bulk-submit.user-error",
        );

        return {
          status: "failed",
          taskId: task.id,
          errorMessage,
        };
      }

      const bulkOperationId = result.bulkOperation?.id;
      if (!bulkOperationId) {
        const errorMessage = "Shopify bulkOperationRunQuery 未返回 bulkOperation.id";
        await failAttemptSubmission({
          attemptId: reservedAttempt.attemptId,
          scanTaskId: reservedAttempt.scanTaskId,
          errorMessage,
        });

        return {
          status: "failed",
          taskId: task.id,
          errorMessage,
        };
      }

      await markAttemptSubmitted({
        attemptId: reservedAttempt.attemptId,
        scanTaskId: reservedAttempt.scanTaskId,
        bulkOperationId,
      });

      await prisma.scanJob.update({
        where: { id: task.scanJobId },
        data: {
          status: "RUNNING",
        },
      });

      logger.info(
        {
          shopId: task.shopId,
          scanJobId: task.scanJobId,
          taskId: task.id,
          attemptId: reservedAttempt.attemptId,
          attemptNo: reservedAttempt.attemptNo,
          resourceType: task.resourceType,
          bulkOperationId,
          submittedAt: new Date().toISOString(),
        },
        "bulk-submit.submitted",
      );

      return {
        status: "submitted",
        taskId: task.id,
        attemptId: reservedAttempt.attemptId,
        bulkOperationId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await failAttemptSubmission({
        attemptId: reservedAttempt.attemptId,
        scanTaskId: reservedAttempt.scanTaskId,
        errorMessage,
      });

      logger.error(
        {
          shopId: task.shopId,
          scanJobId: task.scanJobId,
          taskId: task.id,
          attemptId: reservedAttempt.attemptId,
          resourceType: task.resourceType,
          err: error,
        },
        "bulk-submit.request-failed",
      );

      return {
        status: "failed",
        taskId: task.id,
        errorMessage,
      };
    }
  }
}

export const bulkSubmitService = new BulkSubmitService();
