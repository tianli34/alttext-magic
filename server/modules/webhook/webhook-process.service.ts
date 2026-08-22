/**
 * File: server/modules/webhook/webhook-process.service.ts
 * Purpose: Worker 端消费 WebhookEvent 的业务处理入口。
 * 根据 topic 分发到对应的业务模块（scan / gdpr / scope / billing 等）。
 */
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
import type { WebhookEvent } from "@prisma/client";
import {
  getWebhookTopicHandler,
  normalizeWebhookTopic,
} from "./webhook-topic-registry";

const logger = createLogger({ module: "webhook-process" });

/**
 * 处理单个 WebhookEvent。
 *
 * 1. 从 DB 读取事件
 * 2. 标记为 PROCESSING
 * 3. 按 topic 分发到对应业务模块
 * 4. 成功 → 标记 PROCESSED；失败 → 递增 attempts、记录 errorMessage
 */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });

  if (!event) {
    logger.warn({ webhookEventId }, "webhook.process.event_not_found");
    return;
  }

  const jobLogger = logger.withContext({
    shop_domain: event.shopDomain,
    job_item_id: event.id,
  });

  // 已处理或已合并的事件跳过
  if (event.status === "PROCESSED" || event.coalescedIntoEventId) {
    jobLogger.info(
      { webhookEventId, status: event.status },
      "webhook.process.skipped",
    );
    return;
  }

  // 标记为处理中
  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: {
      status: "PROCESSING",
      processingStartedAt: new Date(),
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  try {
    await dispatchByTopic(event, jobLogger);

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    jobLogger.info(
      { webhookEventId, topic: event.topic },
      "webhook.process.completed",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: {
        status: "PENDING",
        errorMessage: message,
      },
    });

    jobLogger.error(
      { webhookEventId, topic: event.topic, err: error, error_code: "WEBHOOK_PROCESS_FAILED", error_message: message },
      "webhook.process.failed",
    );

    throw error;
  }
}

/**
 * 根据 topic 从注册表分发到对应业务处理器。
 * 业务模块不在此处 import，由 worker 启动时调用 registerWebhookTopicHandlers 绑定。
 * 后续按 topic 路由到具体业务:
 * - PRODUCTS_CREATE / PRODUCTS_UPDATE → continuous scan
 * - COLLECTIONS_CREATE / COLLECTIONS_UPDATE → continuous scan
 * - COLLECTIONS_DELETE → 集合删除收敛（暂未接入）
 * - APP_SCOPES_UPDATE → scope sync
 * - APP_UNINSTALLED → gdpr / cleanup
 * - CUSTOMERS_DATA_REQUEST / CUSTOMERS_REDACT / SHOP_REDACT → gdpr
 */
async function dispatchByTopic(event: WebhookEvent, log: typeof logger): Promise<void> {
  const normalizedTopic = normalizeWebhookTopic(event.topic);

  log.info(
    {
      webhookEventId: event.id,
      topic: event.topic,
      shopDomain: event.shopDomain,
    },
    "webhook.process.dispatch",
  );

  const handler = getWebhookTopicHandler(normalizedTopic);

  if (!handler) {
    log.warn(
      { webhookEventId: event.id, topic: event.topic },
      "webhook.process.no-handler",
    );
    return;
  }

  await handler({
    shopDomain: event.shopDomain,
    payload: event.payload,
  });
}
