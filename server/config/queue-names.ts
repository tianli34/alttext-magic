/**
 * File: server/config/queue-names.ts
 * Purpose: Define BullMQ queue names used by the application.
 */

export const WEBHOOK_QUEUE_NAME = "shopify-webhooks";
export const SCAN_START_QUEUE_NAME = "scan-start";
export const PARSE_BULK_QUEUE_NAME = "parse-bulk";
export const DERIVE_SCAN_QUEUE_NAME = "derive-scan";
export const PUBLISH_SCAN_QUEUE_NAME = "publish-scan";
export const BILLING_SYNC_QUEUE_NAME = "billing-sync";
export const QUOTA_GRANT_QUEUE_NAME = "quota-grant";
export const RESERVATION_REAPER_QUEUE_NAME = "reservation-reaper";
export const GENERATE_ALT_QUEUE_NAME = "generate-alt";
export const WRITEBACK_QUEUE_NAME = "writeback";
export const CONTINUOUS_SCAN_QUEUE_NAME = "continuous-scan";

export const queueNames = {
  webhook: WEBHOOK_QUEUE_NAME,
  scanStart: SCAN_START_QUEUE_NAME,
  parseBulk: PARSE_BULK_QUEUE_NAME,
  deriveScan: DERIVE_SCAN_QUEUE_NAME,
  publishScan: PUBLISH_SCAN_QUEUE_NAME,
  billingSync: BILLING_SYNC_QUEUE_NAME,
  quotaGrant: QUOTA_GRANT_QUEUE_NAME,
  reservationReaper: RESERVATION_REAPER_QUEUE_NAME,
  generateAlt: GENERATE_ALT_QUEUE_NAME,
  writeback: WRITEBACK_QUEUE_NAME,
  continuousScan: CONTINUOUS_SCAN_QUEUE_NAME,
} as const;
