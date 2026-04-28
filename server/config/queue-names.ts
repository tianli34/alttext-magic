/**
 * File: server/config/queue-names.ts
 * Purpose: Define BullMQ queue names used by the application.
 */

export const WEBHOOK_QUEUE_NAME = "shopify-webhooks";
export const SCAN_START_QUEUE_NAME = "scan-start";
export const PARSE_BULK_QUEUE_NAME = "parse-bulk";
export const DERIVE_SCAN_QUEUE_NAME = "derive-scan";
export const PUBLISH_SCAN_QUEUE_NAME = "publish-scan";

export const queueNames = {
  webhook: WEBHOOK_QUEUE_NAME,
  scanStart: SCAN_START_QUEUE_NAME,
  parseBulk: PARSE_BULK_QUEUE_NAME,
  deriveScan: DERIVE_SCAN_QUEUE_NAME,
  publishScan: PUBLISH_SCAN_QUEUE_NAME,
} as const;
