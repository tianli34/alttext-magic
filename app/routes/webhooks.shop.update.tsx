/**
 * File: app/routes/webhooks.shop.update.tsx
 * Purpose: SHOP_UPDATE webhook handler。
 *          商户在 Shopify 后台变更店铺信息（含时区）时触发。
 *          同步更新 shops.timezone 字段，确保后续时间显示使用最新时区。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";
import { createWebhookEventIfAbsent } from "../lib/server/webhooks/webhook.repository.js";
import prisma from "../../server/db/prisma.server";

interface ShopUpdatePayload {
  id: number;
  name: string;
  email: string;
  domain: string;
  iana_timezone?: string;
}

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

  const receipt = await createWebhookEventIfAbsent({
    shop,
    topic,
    webhookId,
    apiVersion,
    payload,
  });

  if (receipt.isNew) {
    const data = payload as ShopUpdatePayload;

    if (data.iana_timezone) {
      await prisma.shop.update({
        where: { shopDomain: shop },
        data: { timezone: data.iana_timezone },
      });

      log.info("webhook.shop_update.timezone_updated", {
        timezone: data.iana_timezone,
      });
    }
  } else {
    log.info("webhook.shop_update.duplicate_skipped");
  }

  return new Response(null, { status: 200 });
};
