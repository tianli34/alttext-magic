/**
 * File: server/modules/scan/catalog/bulk-finish.service.ts
 * Purpose: BULK_OPERATIONS_FINISH webhook 的扫描侧业务处理:
 * 落 attempt 终态 → 入列 parse-bulk → 补位提交下一批 → 终态收敛。
 */
import { z } from "zod";
import { createLogger } from "../../../utils/logger";
import { enqueueParseBulkToStaging } from "../../../queues/parse-bulk.queue";
import { getBulkOperationById } from "./shopify-bulk.client.server";
import { markAttemptFinishedFromWebhook } from "./scan-task-attempt.service";
import { trySubmitNextBatch } from "./scan-start.service";
import { reconcileScanJobLifecycle } from "./scan-lifecycle.service";
import prisma from "../../../db/prisma.server";

const logger = createLogger({ module: "bulk-finish-service" });

/**
 * finish webhook 早于 bulkSubmitService.markAttemptSubmitted 把 bulkOperationId 落库到达时的
 * 竞态兜底重试延迟。开发店小数据量下 bulk op 秒级完成, 竞态窗口实测约 2-3s, 取 5s 留余量。
 */
const WEBHOOK_NOT_FOUND_RETRY_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const bulkFinishWebhookPayloadSchema = z.object({
  admin_graphql_api_id: z.string().min(1),
  status: z.string().min(1),
  error_code: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

function normalizeBulkTerminalStatus(
  status: string,
): "COMPLETED" | "FAILED" | "CANCELED" {
  const normalizedStatus = status.toUpperCase();

  if (
    normalizedStatus === "COMPLETED" ||
    normalizedStatus === "FAILED" ||
    normalizedStatus === "CANCELED"
  ) {
    return normalizedStatus;
  }

  return "FAILED";
}

interface BulkFinishServiceDependencies {
  findShopByDomain(shopDomain: string): Promise<{ id: string } | null>;
  getBulkOperationById: typeof getBulkOperationById;
  markAttemptFinishedFromWebhook: typeof markAttemptFinishedFromWebhook;
  enqueueParseBulkToStaging: typeof enqueueParseBulkToStaging;
  trySubmitNextBatch: typeof trySubmitNextBatch;
  reconcileScanJobLifecycle: typeof reconcileScanJobLifecycle;
  delay: typeof delay;
}

const defaultDependencies: BulkFinishServiceDependencies = {
  async findShopByDomain(shopDomain) {
    return prisma.shop.findUnique({
      where: { shopDomain },
      select: { id: true },
    });
  },
  getBulkOperationById,
  markAttemptFinishedFromWebhook,
  enqueueParseBulkToStaging,
  trySubmitNextBatch,
  reconcileScanJobLifecycle,
  delay,
};

const bulkFinishServiceDependencies: BulkFinishServiceDependencies = {
  ...defaultDependencies,
};

export function setBulkFinishServiceDependenciesForTests(
  overrides: Partial<BulkFinishServiceDependencies>,
): void {
  Object.assign(bulkFinishServiceDependencies, overrides);
}

export function resetBulkFinishServiceDependenciesForTests(): void {
  Object.assign(bulkFinishServiceDependencies, defaultDependencies);
}

export async function handleBulkOperationsFinishWebhook(input: {
  shopDomain: string;
  payload: unknown;
}): Promise<void> {
  const payload = bulkFinishWebhookPayloadSchema.parse(input.payload);
  const shop = await bulkFinishServiceDependencies.findShopByDomain(
    input.shopDomain,
  );

  const webhookLogger = logger.withContext({
    shop_domain: input.shopDomain,
  });

  if (!shop) {
    webhookLogger.warn(
      { payload },
      "bulk-finish.shop-not-found",
    );
    return;
  }

  const bulkOperation = await bulkFinishServiceDependencies.getBulkOperationById(
    shop.id,
    payload.admin_graphql_api_id,
  );

  const normalizedStatus = normalizeBulkTerminalStatus(
    bulkOperation?.status ?? payload.status,
  );
  const finishedAt = bulkOperation?.completedAt
    ? new Date(bulkOperation.completedAt)
    : payload.completed_at
      ? new Date(payload.completed_at)
      : new Date();

  const markInput = {
    bulkOperationId: payload.admin_graphql_api_id,
    bulkOperationStatus: normalizedStatus,
    bulkResultUrl: bulkOperation?.url ?? bulkOperation?.partialDataUrl ?? null,
    finishedAt,
    errorCode: bulkOperation?.errorCode ?? payload.error_code ?? null,
    errorMessage:
      normalizedStatus === "COMPLETED" ? null : "Bulk operation finished with terminal error",
  };

  // 首查静默: 开发店小数据量时 bulk op 可能秒级完成, 其 finish webhook 会早于
  // bulkSubmitService.markAttemptSubmitted 把 bulkOperationId 落库而到达(提交竞态)。
  let completion = await bulkFinishServiceDependencies.markAttemptFinishedFromWebhook({
    ...markInput,
    silentNotFound: true,
  });

  if (!completion) {
    // 竞态兜底: 延迟一次重试, 覆盖落库窗口; 仍查不到视为无关 bulk op / 脏数据,
    // 后续调用按默认(silentNotFound=false)打 warn 暴露事件。
    await bulkFinishServiceDependencies.delay(WEBHOOK_NOT_FOUND_RETRY_DELAY_MS);
    webhookLogger.info(
      { bulkOperationId: payload.admin_graphql_api_id, retryDelayMs: WEBHOOK_NOT_FOUND_RETRY_DELAY_MS },
      "bulk-finish.bulk-operation-not-found-retry",
    );
    completion = await bulkFinishServiceDependencies.markAttemptFinishedFromWebhook(markInput);
  }

  if (!completion) {
    // 未匹配到任何 scanTaskAttempt: 提交竞态下的脏 webhook / 无关 bulk op,
    // 不记录 "finished", 避免与上方 not-found 告警形成矛盾日志。
    return;
  }

  webhookLogger.info(
    {
      shopId: shop.id,
      bulkOperationId: payload.admin_graphql_api_id,
      status: normalizedStatus,
      completedAt: finishedAt.toISOString(),
      bulkResultUrl: bulkOperation?.url ?? bulkOperation?.partialDataUrl ?? null,
      errorCode: bulkOperation?.errorCode ?? payload.error_code ?? null,
    },
    "bulk-finish.bulk-operation-finished",
  );

  if (completion.shouldEnqueueParse) {
    await bulkFinishServiceDependencies.enqueueParseBulkToStaging({
      shopId: completion.shopId,
      scanJobId: completion.scanJobId,
      scanTaskId: completion.scanTaskId,
      scanTaskAttemptId: completion.scanTaskAttemptId,
    });
  }

  if (completion.alreadyTerminal) {
    return;
  }

  await bulkFinishServiceDependencies.trySubmitNextBatch(completion.scanJobId);
  await bulkFinishServiceDependencies.reconcileScanJobLifecycle({
    scanJobId: completion.scanJobId,
    shopId: completion.shopId,
  });
}
