/**
 * File: app/routes/webhooks.shop.redact.tsx
 * Purpose: SHOP_REDACT GDPR webhook handler。
 *          Shopify 在店铺请求删除数据时发送此 webhook。
 *          流程: HMAC 校验 → 幂等持久化 audit_log → 入列 gdpr-delete → 返 200。
 *          说明: SHOP_REDACT 触发后，由 gdpr-delete Worker 异步清空该 shop 全量数据。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";
import { createWebhookEventIfAbsent } from "../lib/server/webhooks/webhook.repository.js";
import { enqueueGdprDelete } from "../../server/queues/gdpr-delete.queue.js";
import prisma from "../../server/db/prisma.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const log = webhookLogger.child({
    topic,
    shop,
    webhookId,
    apiVersion: apiVersion ?? undefined,
  });

  log.info("webhook.verified");

  // 幂等持久化 audit_log
  const receipt = await createWebhookEventIfAbsent({
    shop,
    topic,
    webhookId,
    apiVersion,
    payload,
  });

  if (receipt.isNew) {
    // 查找 shop 记录获取 shopId
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
      select: { id: true },
    });

    if (shopRecord) {
      // 入列 gdpr-delete 异步清理该 shop 全量数据
      await enqueueGdprDelete({
        shopId: shopRecord.id,
        shopDomain: shop,
        reason: "SHOP_REDACT",
        source: topic,
      });

      log.info("webhook.gdpr.shop_redact.gdpr_delete_enqueued", {
        shopId: shopRecord.id,
      });
    } else {
      log.warn("webhook.gdpr.shop_redact.shop_not_found", {
        shopDomain: shop,
      });
    }
  } else {
    log.info("webhook.gdpr.shop_redact.duplicate_skipped", {
      eventId: receipt.eventId,
    });
  }

  return new Response(null, { status: 200 });
};
