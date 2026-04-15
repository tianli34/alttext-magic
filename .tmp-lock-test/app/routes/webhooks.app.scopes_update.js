import { receiveWebhook } from "../lib/server/webhooks/webhook-receive.service.js";
import { authenticate } from "../shopify.server";
import { webhookLogger } from "../../server/utils/logger.js";
export const action = async ({ request }) => {
    const { payload, topic, shop, webhookId, apiVersion } = await authenticate.webhook(request);
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
