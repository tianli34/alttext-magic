/**
 * File: server/modules/scan/continuous/webhook-event.service.ts
 * Purpose: Webhook 事件的 debounce 路由逻辑。
 * 对于 products/update、collections/update 类型的 webhook：
 * - 解析 shopId（由 shopDomain 查询）和 resourceId（从 payload 提取）
 * - 通过 Redis debounce key 合并窗口期内的重复事件
 * - 首次事件投递 delayed job（60s）到 continuous-scan 队列
 * - 后续事件仅更新 debounce key 并标记旧事件为 COALESCED
 */
import prisma from "../../../db/prisma.server";
import * as debounce from "./debounce.service";
import { enqueueDebounceDelayedJob } from "../../../queues/continuous-scan.queue";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "webhook-event" });

/** 需要走 debounce 路由的 topic 集合 */
const DEBOUNCE_TOPICS: ReadonlySet<string> = new Set([
  "products/update",
  "collections/update",
]);

/** Debounce 合并窗口（秒） */
const DEBOUNCE_WINDOW_SEC = 60;

/**
 * 判断 topic 是否需要走 debounce 路由。
 */
export function isDebounceTopic(topic: string): boolean {
  return DEBOUNCE_TOPICS.has(topic);
}

/**
 * 从 webhook payload 中提取 resourceId（Shopify GID）。
 * products/update → payload.id (gid://shopify/Product/xxx)
 * collections/update → payload.id (gid://shopify/Collection/xxx)
 */
function extractResourceId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "string" && id.startsWith("gid://")) {
    return id;
  }
  return null;
}

/**
 * Debounce 路由入口：合并窗口期内的重复 webhook 事件。
 *
 * 流程：
 * 1. 解析 resourceId（从 payload.id）
 * 2. 查询 shopId（从 shopDomain）
 * 3. 持久化 resourceId 到 webhook_event 行
 * 4. tryAcquire(shopId, topic, resourceId, webhookEventId)
 *    - acquired=true  → 投递 delayed job（60s），事件保持 PENDING
 *    - acquired=false → debounce.update 覆盖 webhookEventId，旧事件标 COALESCED
 */
export async function routeDebounceWebhook(params: {
  shopDomain: string;
  topic: string;
  webhookEventId: string;
  payload: unknown;
}): Promise<void> {
  const { shopDomain, topic, webhookEventId, payload } = params;

  // 1. 提取 resourceId
  const resourceId = extractResourceId(payload);
  if (!resourceId) {
    logger.warn(
      { shopDomain, topic, webhookEventId },
      "webhook-event-debounce.no_resource_id",
    );
    return;
  }

  // 2. 查询 shopId
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) {
    logger.warn(
      { shopDomain, topic, webhookEventId },
      "webhook-event-debounce.shop_not_found",
    );
    return;
  }
  const shopId = shop.id;

  // 3. 持久化 resourceId 到 webhook_event（便于后续查询与排障）
  await prisma.webhookEvent
    .update({
      where: { id: webhookEventId },
      data: { resourceId },
    })
    .catch((err: unknown) => {
      logger.warn(
        { webhookEventId, resourceId, err },
        "webhook-event-debounce.resource_id_update_failed",
      );
    });

  // 4. Debounce tryAcquire
  const result = await debounce.tryAcquire(
    shopId,
    topic,
    resourceId,
    webhookEventId,
    DEBOUNCE_WINDOW_SEC,
  );

  if (result.acquired) {
    // 首次事件：投递 delayed job（60s 后触发）
    await enqueueDebounceDelayedJob(
      {
        shopId,
        topic,
        resourceId,
        latestWebhookEventId: webhookEventId,
      },
      DEBOUNCE_WINDOW_SEC * 1000,
    );

    logger.info(
      { shopDomain, topic, resourceId, webhookEventId },
      "webhook-event-debounce.acquired",
    );
  } else {
    // 后续事件：更新 debounce key + 标记旧事件 COALESCED
    await debounce.update(
      shopId,
      topic,
      resourceId,
      webhookEventId,
      DEBOUNCE_WINDOW_SEC,
    );

    if (result.previousWebhookEventId) {
      await prisma.webhookEvent.update({
        where: { id: result.previousWebhookEventId },
        data: {
          status: "COALESCED",
          coalescedIntoEventId: webhookEventId,
        },
      });
    }

    logger.info(
      {
        shopDomain,
        topic,
        resourceId,
        coalescedEventId: result.previousWebhookEventId,
        latestEventId: webhookEventId,
      },
      "webhook-event-debounce.coalesced",
    );
  }
}
