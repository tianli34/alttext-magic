/**
 * File: app/lib/server/webhooks/webhook-receive.service.ts
 * Purpose: Webhook 接收入口 —— 鉴权后由 route handler 调用。
 * 仅执行: 幂等持久化 → 入列 BullMQ → 返回收据。
 * 严禁在此写业务逻辑，业务全交由 Worker 异步处理。
 */
import { createWebhookEventIfAbsent } from "./webhook.repository";
import { enqueueWebhookEvent } from "./webhook.queue";
import { createLogger } from "../../../../server/utils/logger";
import type { ReceiveWebhookEnvelope, WebhookReceipt } from "./webhook.types";

const logger = createLogger({ module: "webhook-receive" });

/**
 * 接收已验证的 Webhook，执行幂等持久化 + 入队。
 *
 * 流程:
 * 1. createWebhookEventIfAbsent — 原子去重写入 DB
 * 2. 仅当 isNew=true 时入列 BullMQ（重复不重新入队）
 * 3. 返回 WebhookReceipt 供 handler 记录日志
 */
export async function receiveWebhook(
  envelope: ReceiveWebhookEnvelope,
): Promise<WebhookReceipt> {
  const receipt = await createWebhookEventIfAbsent(envelope);

  if (receipt.isNew) {
    await enqueueWebhookEvent({ webhookEventId: receipt.eventId });
    logger.info(
      { shop: envelope.shop, topic: envelope.topic, eventId: receipt.eventId },
      "webhook.receive.enqueued",
    );
  } else {
    logger.info(
      { shop: envelope.shop, topic: envelope.topic, eventId: receipt.eventId },
      "webhook.receive.duplicate_skipped",
    );
  }

  return receipt;
}
