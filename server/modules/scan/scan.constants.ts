/**
 * File: server/modules/scan/scan.constants.ts
 * Purpose: 扫描模块的共享常量。
 */
import type { ScopeToResourceMap } from "./scan.types";
import type { ScanResourceType } from "@prisma/client";
import type { ScopeFlag } from "../../../app/lib/scope-utils";

/** Redis 扫描进度键前缀 */
export const SCAN_PROGRESS_KEY_PREFIX = "scan:progress";

/** Redis 扫描进度键过期时间（秒）：24 小时 */
export const SCAN_PROGRESS_TTL_SECONDS = 24 * 60 * 60;

/**
 * 扫描进度阶段枚举。
 * Worker 在关键阶段写 Redis phase 字段，前端通过 SSE 实时读取。
 */
export const SCAN_PHASE = {
  STARTED: "started",
  BULK_SUBMITTED: "bulk_submitted",
  PARSING: "parsing",
  DERIVE: "derive",
  PUBLISH: "publish",
  DONE: "done",
  FAILED: "failed",
} as const;

export type ScanPhase = (typeof SCAN_PHASE)[keyof typeof SCAN_PHASE];

/** ScanResourceType 枚举所有值，用于校验 */
export const ALL_SCAN_RESOURCE_TYPES: ScanResourceType[] = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
];

/**
 * ScopeFlag -> ScanResourceType 的一一映射。
 * ScopeFlag 的 key 与 ScanResourceType 枚举值完全一致。
 */
export const SCOPE_TO_RESOURCE_MAP: ScopeToResourceMap = {
  PRODUCT_MEDIA: "PRODUCT_MEDIA",
  FILES: "FILES",
  COLLECTION_IMAGE: "COLLECTION_IMAGE",
  ARTICLE_IMAGE: "ARTICLE_IMAGE",
} as const;

/**
 * 将 ScopeFlag 列表转换为 ScanResourceType 列表。
 */
export function scopeFlagsToResourceTypes(flags: ScopeFlag[]): ScanResourceType[] {
  return flags.map((flag) => SCOPE_TO_RESOURCE_MAP[flag]);
}
