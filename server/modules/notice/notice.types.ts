/**
 * File: server/modules/notice/notice.types.ts
 * Purpose: Define types for the scan notice acknowledgement service.
 */
import type { ScanScopeFlags } from "../shop/shop.types";

/** Result of checking whether a shop needs to acknowledge the current notice. */
export interface NoticeStatusResult {
  /** Whether the shop must acknowledge the current notice version. */
  needsNoticeAck: boolean;
  /** The version the shop has acknowledged, or null if never acknowledged. */
  acknowledgedVersion: string | null;
  /** The current notice version the app expects. */
  currentVersion: string;
}

/** Parameters for acknowledging a notice. */
export interface AckNoticeInput {
  shopId: string;
  noticeKey: string;
  version: string;
  scopeFlagsSnapshot: ScanScopeFlags;
  actor?: string;
}
