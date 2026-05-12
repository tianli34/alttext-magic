/**
 * File: app/routes/webhooks.app.subscriptions_update.tsx
 * Purpose: APP_SUBSCRIPTIONS_UPDATE webhook handler。
 *          Shopify 在订阅状态变化时发送此 webhook。
 *          遵循标准 webhook 管线：鉴权 → 幂等持久化 → 入列 BullMQ → 返 200。
 *          实际业务逻辑由 Worker 端 webhook-process.service.ts 异步处理。
 */
import type { ActionFunctionArgs } from "react-router";
import { receiveWebhook } from "../lib/server/webhooks/webhook-receive.service.js";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";

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

  await receiveWebhook({
    shop,
    topic,
    webhookId,
    apiVersion,
    payload,
  });

  return new Response(null, { status: 200 });
};
