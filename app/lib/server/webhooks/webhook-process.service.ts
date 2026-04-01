/**
 * File: app/lib/server/webhooks/webhook-process.service.ts
 * Purpose: Load persisted webhook events and apply Phase 1 worker-side processing.
 */
import { webhookLogger } from "../../../../server/utils/logger.js";
import { isGdprTopic } from "./webhook.constants.js";
import {
  getWebhookEventById,
  markShopUninstalled,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  markWebhookEventProcessing,
} from "./webhook.repository.js";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const event = await getWebhookEventById(webhookEventId);
  const log = webhookLogger.child({
    eventId: event.id,
    shop: event.shopDomain,
    topic: event.topic,
    webhookId: event.shopifyWebhookId,
  });

  await markWebhookEventProcessing(event.id);
  log.info("webhook.worker.started");

  try {
    if (event.topic === "APP_UNINSTALLED") {
      await markShopUninstalled(event.shopDomain);

      log.info("webhook.worker.app_uninstalled_marked");
    } else if (isGdprTopic(event.topic)) {
      log.info("webhook.worker.gdpr_noop");
    } else {
      log.info("webhook.worker.phase1_noop");
    }

    await markWebhookEventProcessed(event.id);
    log.info("webhook.worker.completed");
  } catch (error) {
    const errorMessage = toErrorMessage(error);

    await markWebhookEventFailed(event.id, errorMessage);
    log.error("webhook.worker.failed", {
      errorMessage,
    });
    throw error;
  }
}
