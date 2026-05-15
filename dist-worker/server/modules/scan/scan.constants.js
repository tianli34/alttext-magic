/** Redis 扫描进度键前缀 */
export const SCAN_PROGRESS_KEY_PREFIX = "scan:progress";
/** Redis 扫描进度键过期时间（秒）：24 小时 */
export const SCAN_PROGRESS_TTL_SECONDS = 24 * 60 * 60;
/** RUNNING 扫描无进度更新的兜底超时时间：10 分钟 */
export const RUNNING_SCAN_STALE_TIMEOUT_MS = 10 * 60 * 1000;
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
};
/** ScanResourceType 枚举所有值，用于校验 */
export const ALL_SCAN_RESOURCE_TYPES = [
    "PRODUCT_MEDIA",
    "FILES",
    "COLLECTION_IMAGE",
    "ARTICLE_IMAGE",
];
/**
 * ScopeFlag -> ScanResourceType 的一一映射。
 * ScopeFlag 的 key 与 ScanResourceType 枚举值完全一致。
 */
export const SCOPE_TO_RESOURCE_MAP = {
    PRODUCT_MEDIA: "PRODUCT_MEDIA",
    FILES: "FILES",
    COLLECTION_IMAGE: "COLLECTION_IMAGE",
    ARTICLE_IMAGE: "ARTICLE_IMAGE",
};
/**
 * 将 ScopeFlag 列表转换为 ScanResourceType 列表。
 */
export function scopeFlagsToResourceTypes(flags) {
    return flags.map((flag) => SCOPE_TO_RESOURCE_MAP[flag]);
}
