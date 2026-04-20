/**
 * File: server/config/queue-names.ts
 * Purpose: Define BullMQ queue names used by the application.
 */

export const WEBHOOK_QUEUE_NAME = "shopify-webhooks";
export const SCAN_START_QUEUE_NAME = "scan-start";

export const queueNames = {
  webhook: WEBHOOK_QUEUE_NAME,
  scanStart: SCAN_START_QUEUE_NAME,
} as const;
