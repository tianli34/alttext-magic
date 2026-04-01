/**
 * File: app/lib/server/webhooks/webhook-receive.service.ts
 * Purpose: Orchestrate verified webhook receipt, idempotent persistence, and queue enqueueing.
 */
import { webhookLogger } from "../../../../server/utils/logger.js";
import { isPhase1WebhookTopic } from "./webhook.constants.js";
import { enqueueWebhookEvent } from "./webhook.queue.js";
import { createWebhookEventIfAbsent } from "./webhook.repository.js";
import type {
  AuthenticatedWebhookEnvelope,
  PersistedWebhookReceipt,
} from "./webhook.types.js";

export async function receiveWebhook(
  envelope: AuthenticatedWebhookEnvelope,
): Promise<PersistedWebhookReceipt> {
  const log = webhookLogger.child({
    shop: envelope.shop,
    topic: envelope.topic,
    webhookId: envelope.webhookId,
    apiVersion: envelope.apiVersion ?? undefined,
  });

  log.info("webhook.received");

  if (!isPhase1WebhookTopic(envelope.topic)) {
    log.warn("webhook.unexpected_topic");

    return {
      eventId: "",
      isNew: false,
    };
  }

  const receipt = await createWebhookEventIfAbsent(envelope);

  log.info("webhook.persisted", {
    eventId: receipt.eventId,
    isNew: receipt.isNew,
  });

  if (!receipt.isNew) {
    log.info("webhook.duplicate", {
      eventId: receipt.eventId,
    });

    return receipt;
  }

  await enqueueWebhookEvent({
    webhookEventId: receipt.eventId,
  });

  log.info("webhook.enqueued", {
    eventId: receipt.eventId,
  });

  return receipt;
}
