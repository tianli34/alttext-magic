/**
 * File: app/routes/webhooks.customers.data_request.tsx
 * Purpose: CUSTOMERS_DATA_REQUEST GDPR webhook handler。
 *          Shopify 在商户请求客户数据时发送此 webhook。
 *          流程: HMAC 校验 → 幂等持久化 audit_log → 返 200 + 空对象。
 *          说明: App 不存储 customer 数据，因此返回空对象。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";
import { createWebhookEventIfAbsent } from "../lib/server/webhooks/webhook.repository.js";

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
    log.info("webhook.gdpr.customers_data_request.audited", {
      eventId: receipt.eventId,
    });
  } else {
    log.info("webhook.gdpr.customers_data_request.duplicate_skipped", {
      eventId: receipt.eventId,
    });
  }

  // App 不存储 customer 数据，返回空对象
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
