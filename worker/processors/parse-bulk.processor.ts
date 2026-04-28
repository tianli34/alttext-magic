/**
 * File: worker/processors/parse-bulk.processor.ts
 * Purpose: parse_bulk_to_staging Job 处理器。
 *
 * 流程:
 * 1. 从 scan_task_attempt 读取 bulkResultUrl
 * 2. 根据 resourceType 选择对应的 parser callback
 * 3. 调用通用流式 NDJSON 解析器（fetch → 逐行解析 → 批量 flush）
 * 4. flush 回调将 staging 行写入数据库
 * 5. 更新 attempt 的 parsedRows 和状态
 */
import type { Worker } from "bullmq";
import { createLogger } from "../../server/utils/logger";
import prisma from "../../server/db/prisma.server";
import type { ParseBulkJobData } from "../../server/queues/parse-bulk.queue";
import { streamNdjsonFromUrl } from "../../server/modules/scan/catalog/parsers/ndjson-stream-parser";
import { createArticleRowHandler } from "../../server/modules/scan/catalog/parsers/article.parser";
import { createCollectionRowHandler } from "../../server/modules/scan/catalog/parsers/collection.parser";
import { createFilesRowHandler } from "../../server/modules/scan/catalog/parsers/files.parser";
import { createProductMediaRowHandler } from "../../server/modules/scan/catalog/parsers/product-media.parser";
import {
  flushArticleStaging,
  flushCollectionStaging,
  flushMediaFileStaging,
  flushProductMediaStaging,
  countStagingRows,
} from "../../server/modules/scan/catalog/staging.service";
import { enqueueDeriveScan } from "../../server/queues/derive-scan.queue";
import type { ProductMediaFlushItem } from "../../server/modules/scan/catalog/parsers/staging.types";
import type { ScanResourceType, ScanTaskAttemptStatus } from "@prisma/client";
import { bulkSubmitService, type BulkSubmitResult } from "../../server/modules/scan/catalog/bulk-submit.service";
import {
  finalizeScanJobIfTerminal as finalizeScanJobIfTerminalInDb,
  markScanTaskFailed,
  resetScanTaskToPendingForRetry,
} from "../../server/modules/scan/catalog/scan-task.service";
import { enqueuePublishScanResult } from "../../server/queues/publish-scan.queue";
import { updateScanProgressPhase } from "../../server/sse/progress-publisher";
import { SCAN_PHASE } from "../../server/modules/scan/scan.constants";

const logger = createLogger({ module: "parse-bulk-processor" });

type ParseFailureCategory =
  | "BULK_URL_EXPIRED"
  | "BULK_URL_NOT_FOUND"
  | "BULK_DOWNLOAD_TIMEOUT"
  | "BULK_DOWNLOAD_FETCH_FAILED"
  | "PARSE_FATAL";

interface ParseAttemptRecord {
  id: string;
  scanTaskId: string;
  status: ScanTaskAttemptStatus;
  bulkResultUrl: string | null;
  attemptNo: number;
  scanTask: {
    resourceType: ScanResourceType;
    maxParseAttempts: number;
    status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
    successfulAttemptId: string | null;
  };
}

interface ParseBulkProcessorDependencies {
  findAttempt(scanTaskAttemptId: string): Promise<ParseAttemptRecord | null>;
  markAttemptParsing(scanTaskAttemptId: string): Promise<void>;
  parseByResourceType(
    shopId: string,
    scanTaskAttemptId: string,
    resourceType: ScanResourceType,
    bulkResultUrl: string,
  ): Promise<void>;
  countStagingRows(
    scanTaskAttemptId: string,
    resourceType: ScanResourceType,
  ): Promise<number>;
  markAttemptSuccess(input: {
    scanTaskAttemptId: string;
    parsedRows: number;
    finishedAt: Date;
  }): Promise<void>;
  markAttemptFailed(input: {
    scanTaskAttemptId: string;
    errorMessage: string;
    finishedAt: Date;
  }): Promise<void>;
  enqueueDeriveScan: typeof enqueueDeriveScan;
  markScanTaskFailed: typeof markScanTaskFailed;
  resetScanTaskToPendingForRetry: typeof resetScanTaskToPendingForRetry;
  submitTask(scanTaskId: string): Promise<BulkSubmitResult>;
  finalizeScanJobIfTerminal(
    scanJobId: string,
  ): Promise<{ status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | "RUNNING"; transitioned: boolean } | null>;
  enqueuePublishScanResult: typeof enqueuePublishScanResult;
}

const defaultDependencies: ParseBulkProcessorDependencies = {
  async findAttempt(scanTaskAttemptId) {
    return prisma.scanTaskAttempt.findUnique({
      where: { id: scanTaskAttemptId },
      select: {
        id: true,
        scanTaskId: true,
        status: true,
        bulkResultUrl: true,
        attemptNo: true,
        scanTask: {
          select: {
            resourceType: true,
            maxParseAttempts: true,
            status: true,
            successfulAttemptId: true,
          },
        },
      },
    });
  },
  async markAttemptParsing(scanTaskAttemptId) {
    await prisma.scanTaskAttempt.update({
      where: { id: scanTaskAttemptId },
      data: { status: "PARSING" },
    });
  },
  parseByResourceType,
  countStagingRows,
  async markAttemptSuccess(input) {
    await prisma.scanTaskAttempt.update({
      where: { id: input.scanTaskAttemptId },
      data: {
        status: "SUCCESS",
        parsedRows: input.parsedRows,
        finishedAt: input.finishedAt,
        lastParseError: null,
      },
    });
  },
  async markAttemptFailed(input) {
    await prisma.scanTaskAttempt.update({
      where: { id: input.scanTaskAttemptId },
      data: {
        status: "FAILED",
        lastParseError: input.errorMessage,
        finishedAt: input.finishedAt,
      },
    });
  },
  enqueueDeriveScan,
  markScanTaskFailed,
  resetScanTaskToPendingForRetry,
  submitTask(scanTaskId) {
    return bulkSubmitService.submitTask(scanTaskId);
  },
  async finalizeScanJobIfTerminal(scanJobId) {
    return finalizeScanJobIfTerminalInDb(scanJobId);
  },
  enqueuePublishScanResult,
};

const parseBulkProcessorDependencies: ParseBulkProcessorDependencies = {
  ...defaultDependencies,
};

export function setParseBulkProcessorDependenciesForTests(
  overrides: Partial<ParseBulkProcessorDependencies>,
): void {
  Object.assign(parseBulkProcessorDependencies, overrides);
}

export function resetParseBulkProcessorDependenciesForTests(): void {
  Object.assign(parseBulkProcessorDependencies, defaultDependencies);
}

/* ------------------------------------------------------------------ */
/*  Processor 工厂                                                     */
/* ------------------------------------------------------------------ */

export default function createParseBulkProcessor(
  worker: Worker<ParseBulkJobData>,
): void {
  worker.on("completed", async (job) => {
    logger.info({ jobId: job.id, data: job.data }, "parse-bulk.completed");
  });

  worker.on("failed", async (job, err) => {
    logger.error(
      { jobId: job?.id, data: job?.data, err: err.message },
      "parse-bulk.failed",
    );
  });
}

/* ------------------------------------------------------------------ */
/*  核心处理函数（供 worker/index.ts 直接调用）                          */
/* ------------------------------------------------------------------ */

/**
 * 处理 parse_bulk_to_staging Job。
 *
 * @param data - Job 数据（shopId, scanJobId, scanTaskId, scanTaskAttemptId）
 */
export async function processParseBulkJob(
  data: ParseBulkJobData,
): Promise<void> {
  const { shopId, scanJobId, scanTaskId, scanTaskAttemptId } = data;

  logger.info({ shopId, scanTaskId, scanTaskAttemptId }, "parse-bulk.start");

  // 1. 读取 attempt 信息，获取 bulkResultUrl 和 resourceType
  const attempt = await parseBulkProcessorDependencies.findAttempt(scanTaskAttemptId);

  if (!attempt) {
    throw new Error(`ScanTaskAttempt not found: ${scanTaskAttemptId}`);
  }

  if (
    attempt.status === "SUCCESS" &&
    attempt.scanTask.successfulAttemptId === scanTaskAttemptId
  ) {
    logger.warn(
      {
        attemptId: scanTaskAttemptId,
        status: attempt.status,
        taskStatus: attempt.scanTask.status,
        successfulAttemptId: attempt.scanTask.successfulAttemptId,
      },
      "parse-bulk.attempt-already-derived",
    );
    return;
  }

  if (attempt.status === "SUCCESS") {
    await parseBulkProcessorDependencies.enqueueDeriveScan({
      shopId,
      scanJobId,
      scanTaskId,
      scanTaskAttemptId,
    });

    logger.info(
      { shopId, scanTaskId, scanTaskAttemptId },
      "parse-bulk.derive-reenqueued",
    );

    return;
  }

  if (attempt.status !== "READY_TO_PARSE") {
    logger.warn(
      {
        attemptId: scanTaskAttemptId,
        status: attempt.status,
        taskStatus: attempt.scanTask.status,
      },
      "parse-bulk.attempt-not-ready",
    );
    return;
  }

  if (!attempt.bulkResultUrl) {
    throw new Error(
      `ScanTaskAttempt ${scanTaskAttemptId} has no bulkResultUrl`,
    );
  }

  const resourceType = attempt.scanTask.resourceType as ScanResourceType;

  // 2. 标记 attempt 为 PARSING
  await parseBulkProcessorDependencies.markAttemptParsing(scanTaskAttemptId);

  // 更新 Redis 进度阶段为 parsing
  await updateScanProgressPhase(
    scanJobId,
    SCAN_PHASE.PARSING,
    `正在解析 ${resourceType} 数据…`,
  );

  try {
    // 3. 根据资源类型选择 parser 并执行流式解析
    await parseBulkProcessorDependencies.parseByResourceType(
      shopId,
      scanTaskAttemptId,
      resourceType,
      attempt.bulkResultUrl,
    );

    // 4. 统计已写入行数
    const parsedRows = await parseBulkProcessorDependencies.countStagingRows(
      scanTaskAttemptId,
      resourceType,
    );
    const finishedAt = new Date();

    // 5. 标记 attempt 为 SUCCESS
    await parseBulkProcessorDependencies.markAttemptSuccess({
      scanTaskAttemptId,
      parsedRows,
      finishedAt,
    });

    logger.info(
      { shopId, scanTaskId, scanTaskAttemptId, resourceType, parsedRows },
      "parse-bulk.success",
    );

    // 6. 投递 derive job（staging → 候选目标推导）
    await enqueueDeriveScan({
      shopId,
      scanJobId,
      scanTaskId,
      scanTaskAttemptId,
    });

    logger.info(
      { shopId, scanTaskId, scanTaskAttemptId },
      "parse-bulk.derive-enqueued",
    );
  } catch (error) {
    const failure = classifyParseFailure(error);
    const finishedAt = new Date();
    const errorMessage = `[${failure.category}] ${failure.message}`;

    await parseBulkProcessorDependencies.markAttemptFailed({
      scanTaskAttemptId,
      errorMessage,
      finishedAt,
    });

    logger.error(
      {
        shopId,
        scanJobId,
        scanTaskId,
        scanTaskAttemptId,
        resourceType,
        attemptNo: attempt.attemptNo,
        maxParseAttempts: attempt.scanTask.maxParseAttempts,
        errorCategory: failure.category,
        error: failure.message,
        retryable: failure.retryable,
      },
      "parse-bulk.error",
    );

    if (
      failure.retryable &&
      attempt.attemptNo < attempt.scanTask.maxParseAttempts
    ) {
      await parseBulkProcessorDependencies.resetScanTaskToPendingForRetry({
        scanTaskId,
      });

      const retrySubmitResult = await parseBulkProcessorDependencies.submitTask(
        scanTaskId,
      );

      logger.warn(
        {
          shopId,
          scanJobId,
          scanTaskId,
          scanTaskAttemptId,
          previousAttemptNo: attempt.attemptNo,
          nextAttemptNo: attempt.attemptNo + 1,
          maxParseAttempts: attempt.scanTask.maxParseAttempts,
          errorCategory: failure.category,
          submitStatus: retrySubmitResult.status,
        },
        "parse-bulk.retry-submitted",
      );

      if (retrySubmitResult.status === "submitted") {
        return;
      }

      if (retrySubmitResult.status === "slot_exhausted") {
        return;
      }

      const terminalErrorMessage =
        retrySubmitResult.status === "failed"
          ? `[PARSE_RETRY_SUBMIT_FAILED] ${retrySubmitResult.errorMessage}`
          : `[PARSE_RETRY_SUBMIT_SKIPPED] scan task is not pending`;

      await parseBulkProcessorDependencies.markScanTaskFailed({
        scanTaskId,
        errorMessage: terminalErrorMessage,
        finishedAt: new Date(),
      });
      const finalizeResult =
        await parseBulkProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);

      if (
        finalizeResult?.transitioned &&
        (finalizeResult.status === "SUCCESS" ||
          finalizeResult.status === "PARTIAL_SUCCESS")
      ) {
        await parseBulkProcessorDependencies.enqueuePublishScanResult({
          shopId,
          scanJobId,
        });
      }
      return;
    }

    await parseBulkProcessorDependencies.markScanTaskFailed({
      scanTaskId,
      errorMessage,
      finishedAt,
    });
    const finalizeResult =
      await parseBulkProcessorDependencies.finalizeScanJobIfTerminal(scanJobId);

    if (
      finalizeResult?.transitioned &&
      (finalizeResult.status === "SUCCESS" ||
        finalizeResult.status === "PARTIAL_SUCCESS")
    ) {
      await parseBulkProcessorDependencies.enqueuePublishScanResult({
        shopId,
        scanJobId,
      });
    }
  }
}

function classifyParseFailure(error: unknown): {
  category: ParseFailureCategory;
  message: string;
  retryable: boolean;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.trim().length > 0 ? rawMessage.trim() : "Unknown parse error";
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("403") ||
    normalizedMessage.includes("forbidden") ||
    normalizedMessage.includes("expired")
  ) {
    return {
      category: "BULK_URL_EXPIRED",
      message,
      retryable: true,
    };
  }

  if (
    normalizedMessage.includes("404") ||
    normalizedMessage.includes("not found")
  ) {
    return {
      category: "BULK_URL_NOT_FOUND",
      message,
      retryable: true,
    };
  }

  if (
    normalizedMessage.includes("timeout") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("abort")
  ) {
    return {
      category: "BULK_DOWNLOAD_TIMEOUT",
      message,
      retryable: true,
    };
  }

  if (
    normalizedMessage.includes("fetch failed") ||
    normalizedMessage.includes("response body is null") ||
    normalizedMessage.includes("econnreset") ||
    normalizedMessage.includes("enotfound") ||
    normalizedMessage.includes("socket hang up")
  ) {
    return {
      category: "BULK_DOWNLOAD_FETCH_FAILED",
      message,
      retryable: true,
    };
  }

  return {
    category: "PARSE_FATAL",
    message,
    retryable: false,
  };
}

/* ------------------------------------------------------------------ */
/*  按资源类型分发解析                                                   */
/* ------------------------------------------------------------------ */

async function parseByResourceType(
  shopId: string,
  scanTaskAttemptId: string,
  resourceType: ScanResourceType,
  bulkResultUrl: string,
): Promise<void> {
  switch (resourceType) {
    case "ARTICLE_IMAGE": {
      const handler = createArticleRowHandler();
      await streamNdjsonFromUrl(bulkResultUrl, {
        batchSize: 500,
        handleRow: handler,
        onFlush: async (batch) => {
          await flushArticleStaging(shopId, scanTaskAttemptId, batch);
        },
        onProgress: (stats) => {
          logger.debug(
            {
              shopId,
              scanTaskAttemptId,
              resourceType,
              totalLines: stats.totalLines,
              flushedBatches: stats.flushedBatches,
            },
            "parse-bulk.article.progress",
          );
        },
      });
      break;
    }

    case "COLLECTION_IMAGE": {
      const handler = createCollectionRowHandler();
      await streamNdjsonFromUrl(bulkResultUrl, {
        batchSize: 500,
        handleRow: handler,
        onFlush: async (batch) => {
          await flushCollectionStaging(shopId, scanTaskAttemptId, batch);
        },
      });
      break;
    }

    case "FILES": {
      const handler = createFilesRowHandler();
      await streamNdjsonFromUrl(bulkResultUrl, {
        batchSize: 500,
        handleRow: handler,
        onFlush: async (batch) => {
          await flushMediaFileStaging(shopId, scanTaskAttemptId, batch);
        },
      });
      break;
    }

    case "PRODUCT_MEDIA": {
      const pmHandler = createProductMediaRowHandler();
      await streamNdjsonFromUrl<ProductMediaFlushItem>(bulkResultUrl, {
        batchSize: 500,
        handleRow: pmHandler.handleRow,
        onFlush: async (batch) => {
          await flushProductMediaStaging(shopId, scanTaskAttemptId, batch);
        },
        onProgress: (stats) => {
          logger.debug(
            {
              shopId,
              scanTaskAttemptId,
              resourceType,
              totalLines: stats.totalLines,
              flushedBatches: stats.flushedBatches,
              cachedProducts: pmHandler.getProductCache().size,
            },
            "parse-bulk.product-media.progress",
          );
        },
      });
      pmHandler.dispose();
      break;
    }

    default:
      throw new Error(`Unsupported resourceType: ${resourceType}`);
  }
}
