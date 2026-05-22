/**
 * File: app/lib/server/webhooks/webhook-receive.service.ts
 * Purpose: Webhook 接收入口 —— 鉴权后由 route handler 调用。
 * 仅执行: 幂等持久化 → 按 topic 路由（debounce / 通用队列）→ 返回收据。
 * 严禁在此写业务逻辑，业务全交由 Worker 异步处理。
 */
import { createWebhookEventIfAbsent } from "./webhook.repository";
import { enqueueWebhookEvent } from "./webhook.queue";
import { createLogger } from "../../../../server/utils/logger";
import type { ReceiveWebhookEnvelope, WebhookReceipt } from "./webhook.types";
import {
  isDebounceTopic,
  routeDebounceWebhook,
} from "../../../../server/modules/scan/continuous/webhook-event.service";

const logger = createLogger({ module: "webhook-receive" });

/**
 * 接收已验证的 Webhook，执行幂等持久化 + 按路由入队。
 *
 * 流程:
 * 1. createWebhookEventIfAbsent — 原子去重写入 DB
 * 2. 仅当 isNew=true 时按 topic 路由：
 *    - products/update、collections/update → debounce 路由（合并窗口 + delayed job）
 *    - 其他 topic → 通用 webhook 队列
 * 3. 返回 WebhookReceipt 供 handler 记录日志
 */
export async function receiveWebhook(
  envelope: ReceiveWebhookEnvelope,
): Promise<WebhookReceipt> {
  const receipt = await createWebhookEventIfAbsent(envelope);

  if (receipt.isNew) {
    if (isDebounceTopic(envelope.topic)) {
      // products/update、collections/update → debounce 防抖路由
      await routeDebounceWebhook({
        shopDomain: envelope.shop,
        topic: envelope.topic,
        webhookEventId: receipt.eventId,
        payload: envelope.payload,
      });
      logger.info(
        { shop: envelope.shop, topic: envelope.topic, eventId: receipt.eventId },
        "webhook.receive.debounce_routed",
      );
    } else {
      // 其他 topic → 通用 webhook 队列
      await enqueueWebhookEvent({ webhookEventId: receipt.eventId });
      logger.info(
        { shop: envelope.shop, topic: envelope.topic, eventId: receipt.eventId },
        "webhook.receive.enqueued",
      );
    }
  } else {
    logger.info(
      { shop: envelope.shop, topic: envelope.topic, eventId: receipt.eventId },
      "webhook.receive.duplicate_skipped",
    );
  }

  return receipt;
}
