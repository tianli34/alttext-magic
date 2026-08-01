/**
 * File: app/routes/webhooks.app.uninstalled.tsx
 * Purpose: APP_UNINSTALLED webhook handler。
 *          Shopify 在商户卸载 App 时发送此 webhook。
 *          流程: 鉴权 → 幂等持久化 → 同步标记 shop 已卸载 + 清空 legacy token 占位 → 入列 gdpr-delete → 返 200。
 *          注意: 后台鉴权以 Session 表为准，shops token 字段仅作 legacy 非空占位。
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

  // 1. 幂等持久化 webhook_event
  const receipt = await createWebhookEventIfAbsent({
    shop,
    topic,
    webhookId,
    apiVersion,
    payload,
  });

  if (receipt.isNew) {
    // 2. 同步: 标记 shop 已卸载 + 清空 legacy token 占位字段。
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
      select: { id: true },
    });

    if (shopRecord) {
      await prisma.shop.update({
        where: { id: shopRecord.id },
        data: {
          uninstalledAt: new Date(),
          accessTokenEncrypted: "",
          accessTokenNonce: "",
          accessTokenTag: "",
        },
      });

      log.info("webhook.app_uninstalled.shop_marked_uninstalled", {
        shopId: shopRecord.id,
      });

      // 3. 入列 gdpr-delete 异步清理所有关联数据
      await enqueueGdprDelete({
        shopId: shopRecord.id,
        shopDomain: shop,
        reason: "APP_UNINSTALLED",
        source: topic,
      });

      log.info("webhook.app_uninstalled.gdpr_delete_enqueued", {
        shopId: shopRecord.id,
        shopDomain: shop,
      });
    } else {
      log.warn("webhook.app_uninstalled.shop_not_found", {
        shopDomain: shop,
      });
    }
  } else {
    log.info("webhook.app_uninstalled.duplicate_skipped", {
      eventId: receipt.eventId,
    });
  }

  // 4. 立即返回 200
  return new Response(null, { status: 200 });
};
