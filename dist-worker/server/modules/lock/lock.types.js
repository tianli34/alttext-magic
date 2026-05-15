/**
 * File: server/modules/lock/lock.types.ts
 * Purpose: 定义 shop 级操作锁的服务端类型。
 *
 * 说明：
 * - 当前表结构仅提供 `batch_id` 作为 owner 持久化字段，
 *   因此服务层以 `batchId` 作为“同一持有者”判定依据。
 * - 若后续需要更细粒度 owner（如 workerId / requestId），
 *   需要先扩展 schema，再调整这里的类型。
 */
/** 支持互斥的重操作类型。 */
export const SHOP_OPERATION_TYPES = [
    "SCAN",
    "GENERATE",
    "WRITEBACK",
];
/** 锁记录状态。 */
export const SHOP_OPERATION_LOCK_STATUSES = [
    "RUNNING",
    "RELEASED",
    "EXPIRED",
];
