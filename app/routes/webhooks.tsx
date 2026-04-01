/**
 * File: app/routes/webhooks.tsx
 * Purpose: Verify Shopify webhook requests and hand off durable processing to the queue pipeline.
 */
import type { ActionFunctionArgs } from "react-router";
import { receiveWebhook } from "../lib/server/webhooks/webhook-receive.service.js";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
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

    log.info("webhook.http_accepted");

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof Response) {
      webhookLogger.error("webhook.rejected", {
        status: error.status,
        statusText: error.statusText,
      });

      throw error;
    }

    webhookLogger.error("webhook.unhandled_error", {
      message: error instanceof Error ? error.message : String(error),
    });

    return new Response(null, { status: 500 });
  }
};
