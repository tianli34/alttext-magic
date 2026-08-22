/**
 * File: server/modules/scan/catalog/parse-bulk.service.ts
 * Purpose: parse_bulk_to_staging 作业的业务编排（worker 处理器仅薄壳调用本模块）。
 *
 * 流程:
 * 1. 从 scan_task_attempt 读取 bulkResultUrl
 * 2. 根据 resourceType 选择对应的 parser callback
 * 3. 调用通用流式 NDJSON 解析器（fetch → 逐行解析 → 批量 flush）
 * 4. flush 回调将 staging 行写入数据库
 * 5. 更新 attempt 的 parsedRows 和状态、Redis 进度
 * 6. 投递 derive job；失败时按分类决定重试（回退 PENDING 重新入列 scan_start）或终态收敛
 */
import { createLogger } from "../../../utils/logger";
import prisma from "../../../db/prisma.server";
import type { ParseBulkJobData } from "../../../queues/parse-bulk.queue";
import { streamNdjsonFromUrl } from "./parsers/ndjson-stream-parser";
import { createArticleRowHandler } from "./parsers/article.parser";
import { createCollectionRowHandler } from "./parsers/collection.parser";
import { createFilesRowHandler } from "./parsers/files.parser";
import { createProductMediaRowHandler } from "./parsers/product-media.parser";
import {
  flushArticleStaging,
  flushCollectionStaging,
  flushMediaFileStaging,
  flushProductMediaStaging,
  countStagingRows,
  countMediaImages,
} from "./staging.service";
import { enqueueDeriveScan } from "../../../queues/derive-scan.queue";
import type { ProductMediaFlushItem } from "./parsers/staging.types";
import type { ScanResourceType, ScanTaskAttemptStatus } from "@prisma/client";
import { enqueueScanStart } from "../../../queues/scan-start.queue";
import { markScanTaskFailed, resetScanTaskToPendingForRetry } from "./scan-task.service";
import { reconcileScanJobLifecycle } from "./scan-lifecycle.service";
import {
  updateScanProgressPhase,
  addScanTotalImages,
  addScanResourceTotalImages,
} from "../../../sse/progress-publisher";
import { SCAN_PHASE } from "../scan.constants";

const logger = createLogger({ module: "parse-bulk-service" });

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

interface ParseBulkServiceDependencies {
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
  countMediaImages(
    scanTaskAttemptId: string,
    resourceType: ScanResourceType,
  ): Promise<number>;
  markAttemptSuccess(input: {
    scanTaskAttemptId: string;
    parsedRows: number;
    totalImages: number;
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
  enqueueScanStartRetry(input: {
    shopId: string;
    scanJobId: string;
  }): Promise<void>;
  reconcileScanJobLifecycle: typeof reconcileScanJobLifecycle;
}

const defaultDependencies: ParseBulkServiceDependencies = {
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
  countMediaImages,
  async markAttemptSuccess(input) {
    await prisma.scanTaskAttempt.update({
      where: { id: input.scanTaskAttemptId },
      data: {
        status: "SUCCESS",
        parsedRows: input.parsedRows,
        totalImages: input.totalImages,
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
  async enqueueScanStartRetry({ shopId, scanJobId }) {
    // 重试提交交由 scan_start 作业统一负责: 读取 scanJob 的 scopeFlags 后入列
    const scanJob = await prisma.scanJob.findUnique({
      where: { id: scanJobId },
      select: { scopeFlags: true },
    });
    await enqueueScanStart({
      shopId,
      scanJobId,
      scopeFlags: (scanJob?.scopeFlags ?? {}) as Record<string, boolean>,
    });
  },
  reconcileScanJobLifecycle,
};

const parseBulkServiceDependencies: ParseBulkServiceDependencies = {
  ...defaultDependencies,
};

export function setParseBulkServiceDependenciesForTests(
  overrides: Partial<ParseBulkServiceDependencies>,
): void {
  Object.assign(parseBulkServiceDependencies, overrides);
}

export function resetParseBulkServiceDependenciesForTests(): void {
  Object.assign(parseBulkServiceDependencies, defaultDependencies);
}

/**
 * 处理 parse_bulk_to_staging Job。
 *
 * @param data - Job 数据（shopId, scanJobId, scanTaskId, scanTaskAttemptId）
 */
export async function processParseBulk(
  data: ParseBulkJobData,
): Promise<void> {
  const { shopId, scanJobId, scanTaskId, scanTaskAttemptId } = data;

  const jobLogger = logger.withContext({
    shop_domain: shopId,
    batch_id: scanJobId,
    job_item_id: scanTaskAttemptId,
  });

  jobLogger.info({ shopId, scanTaskId, scanTaskAttemptId }, "parse-bulk.start");

  // 1. 读取 attempt 信息，获取 bulkResultUrl 和 resourceType
  const attempt = await parseBulkServiceDependencies.findAttempt(scanTaskAttemptId);

  if (!attempt) {
    throw new Error(`ScanTaskAttempt not found: ${scanTaskAttemptId}`);
  }

  if (
    attempt.status === "SUCCESS" &&
    attempt.scanTask.successfulAttemptId === scanTaskAttemptId
  ) {
    jobLogger.warn(
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
    await parseBulkServiceDependencies.enqueueDeriveScan({
      shopId,
      scanJobId,
      scanTaskId,
      scanTaskAttemptId,
    });

    jobLogger.info(
      { shopId, scanTaskId, scanTaskAttemptId },
      "parse-bulk.derive-reenqueued",
    );

    return;
  }

  if (attempt.status !== "READY_TO_PARSE") {
    jobLogger.warn(
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
  await parseBulkServiceDependencies.markAttemptParsing(scanTaskAttemptId);

  // 更新 Redis 进度阶段为 parsing
  await updateScanProgressPhase(
    scanJobId,
    SCAN_PHASE.PARSING,
    `正在解析 ${resourceType} 数据…`,
  );

  try {
    // 3. 根据资源类型选择 parser 并执行流式解析
    await parseBulkServiceDependencies.parseByResourceType(
      shopId,
      scanTaskAttemptId,
      resourceType,
      attempt.bulkResultUrl,
    );

    // 4. 统计已写入行数 + 图片（原料）总数
    const parsedRows = await parseBulkServiceDependencies.countStagingRows(
      scanTaskAttemptId,
      resourceType,
    );
    const totalImages = await parseBulkServiceDependencies.countMediaImages(
      scanTaskAttemptId,
      resourceType,
    );
    const finishedAt = new Date();

    // 5. 累加图片总数到 Redis 进度（供图片级百分比使用）
    await addScanTotalImages(scanJobId, totalImages);
    // 5.1 按资源类型累加图片总数（供每类独立进度条使用）
    await addScanResourceTotalImages(scanJobId, resourceType, totalImages);

    // 6. 标记 attempt 为 SUCCESS
    await parseBulkServiceDependencies.markAttemptSuccess({
      scanTaskAttemptId,
      parsedRows,
      totalImages,
      finishedAt,
    });

    jobLogger.info(
      { shopId, scanTaskId, scanTaskAttemptId, resourceType, parsedRows },
      "parse-bulk.success",
    );

    // 6. 投递 derive job（staging → 候选目标推导）
    await parseBulkServiceDependencies.enqueueDeriveScan({
      shopId,
      scanJobId,
      scanTaskId,
      scanTaskAttemptId,
    });

    jobLogger.info(
      { shopId, scanTaskId, scanTaskAttemptId },
      "parse-bulk.derive-enqueued",
    );
  } catch (error) {
    const failure = classifyParseFailure(error);
    const finishedAt = new Date();
    const errorMessage = `[${failure.category}] ${failure.message}`;

    await parseBulkServiceDependencies.markAttemptFailed({
      scanTaskAttemptId,
      errorMessage,
      finishedAt,
    });

    jobLogger.error(
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
      // 重试不直接重新提交 bulk query: 回退 PENDING 后交由 scan_start 作业
      // 统一负责提交与槽位调度(其内部含终态收敛 reconcileScanJobLifecycle)
      await parseBulkServiceDependencies.resetScanTaskToPendingForRetry({
        scanTaskId,
      });

      await parseBulkServiceDependencies.enqueueScanStartRetry({
        shopId,
        scanJobId,
      });

      jobLogger.warn(
        {
          shopId,
          scanJobId,
          scanTaskId,
          scanTaskAttemptId,
          previousAttemptNo: attempt.attemptNo,
          nextAttemptNo: attempt.attemptNo + 1,
          maxParseAttempts: attempt.scanTask.maxParseAttempts,
          errorCategory: failure.category,
        },
        "parse-bulk.retry-requeued-scan-start",
      );

      return;
    }

    await parseBulkServiceDependencies.markScanTaskFailed({
      scanTaskId,
      errorMessage,
      finishedAt,
    });
    await parseBulkServiceDependencies.reconcileScanJobLifecycle({ scanJobId, shopId });
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
