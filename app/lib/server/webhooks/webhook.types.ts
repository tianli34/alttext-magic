/**
 * File: app/lib/server/webhooks/webhook.types.ts
 * Purpose: Define shared types for webhook receipt, persistence, queueing, and processing.
 */
import type { Prisma } from "@prisma/client";

export const GDPR_TOPICS = [
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
] as const;

export const PHASE1_WEBHOOK_TOPICS = [
  "APP_UNINSTALLED",
  ...GDPR_TOPICS,
  "BULK_OPERATIONS_FINISH",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "COLLECTIONS_CREATE",
  "COLLECTIONS_UPDATE",
  "COLLECTIONS_DELETE",
] as const;

export type GdprTopic = (typeof GDPR_TOPICS)[number];
export type Phase1WebhookTopic = (typeof PHASE1_WEBHOOK_TOPICS)[number];

export const WEBHOOK_EVENT_STATUS = {
  pending: "PENDING",
  processing: "PROCESSING",
  processed: "PROCESSED",
  failed: "FAILED",
} as const;

export type WebhookEventStatus =
  (typeof WEBHOOK_EVENT_STATUS)[keyof typeof WEBHOOK_EVENT_STATUS];

export type WebhookPayload = Prisma.InputJsonValue;

export interface AuthenticatedWebhookEnvelope {
  shop: string;
  topic: string;
  webhookId: string;
  apiVersion: string | null;
  payload: WebhookPayload;
}

export interface PersistedWebhookReceipt {
  eventId: string;
  isNew: boolean;
}

export interface WebhookQueueJobData {
  webhookEventId: string;
}
