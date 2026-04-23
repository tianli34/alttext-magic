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
import type { ProductMediaFlushItem } from "../../server/modules/scan/catalog/parsers/staging.types";
import type { ScanResourceType } from "@prisma/client";

const logger = createLogger({ module: "parse-bulk-processor" });

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
  const { shopId, scanTaskId, scanTaskAttemptId } = data;

  logger.info({ shopId, scanTaskId, scanTaskAttemptId }, "parse-bulk.start");

  // 1. 读取 attempt 信息，获取 bulkResultUrl 和 resourceType
  const attempt = await prisma.scanTaskAttempt.findUnique({
    where: { id: scanTaskAttemptId },
    select: {
      id: true,
      scanTaskId: true,
      status: true,
      bulkResultUrl: true,
      scanTask: {
        select: {
          resourceType: true,
        },
      },
    },
  });

  if (!attempt) {
    throw new Error(`ScanTaskAttempt not found: ${scanTaskAttemptId}`);
  }

  if (attempt.status !== "READY_TO_PARSE") {
    logger.warn(
      { attemptId: scanTaskAttemptId, status: attempt.status },
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
  await prisma.scanTaskAttempt.update({
    where: { id: scanTaskAttemptId },
    data: { status: "PARSING" },
  });

  try {
    // 3. 根据资源类型选择 parser 并执行流式解析
    await parseByResourceType(
      shopId,
      scanTaskAttemptId,
      resourceType,
      attempt.bulkResultUrl,
    );

    // 4. 统计已写入行数
    const parsedRows = await countStagingRows(scanTaskAttemptId, resourceType);

    // 5. 标记 attempt 为 SUCCESS
    await prisma.scanTaskAttempt.update({
      where: { id: scanTaskAttemptId },
      data: {
        status: "SUCCESS",
        parsedRows,
        finishedAt: new Date(),
      },
    });

    logger.info(
      { shopId, scanTaskId, scanTaskAttemptId, resourceType, parsedRows },
      "parse-bulk.success",
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // 标记 attempt 为 FAILED
    await prisma.scanTaskAttempt.update({
      where: { id: scanTaskAttemptId },
      data: {
        status: "FAILED",
        lastParseError: errorMessage,
        finishedAt: new Date(),
      },
    });

    logger.error(
      {
        shopId,
        scanTaskId,
        scanTaskAttemptId,
        resourceType,
        error: errorMessage,
      },
      "parse-bulk.error",
    );

    throw error;
  }
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
