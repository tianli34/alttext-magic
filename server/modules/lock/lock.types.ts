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
] as const;

export type ShopOperationType = (typeof SHOP_OPERATION_TYPES)[number];

/** 锁记录状态。 */
export const SHOP_OPERATION_LOCK_STATUSES = [
  "RUNNING",
  "RELEASED",
  "EXPIRED",
] as const;

export type ShopOperationLockStatus =
  (typeof SHOP_OPERATION_LOCK_STATUSES)[number];

/** 当前 schema 下，owner 以 batchId 唯一标识。 */
export interface ShopOperationLockOwner {
  batchId: string;
}

/** 供业务层消费的锁快照。 */
export interface ShopOperationLockSnapshot {
  shopId: string;
  operationType: ShopOperationType;
  batchId: string | null;
  acquiredAt: Date;
  heartbeatAt: Date | null;
  expiresAt: Date;
  releasedAt: Date | null;
  status: ShopOperationLockStatus;
}

/** acquire/heartbeat 可覆盖 TTL；默认 30 分钟。 */
export interface OperationLockTimingOptions {
  ttlMs?: number;
}

/** 获取锁结果。 */
export interface AcquireLockResult {
  acquired: boolean;
  mode: "CREATED" | "REFRESHED" | "RECLAIMED" | "CONFLICT";
  lock: ShopOperationLockSnapshot;
}

/** 释放锁结果。 */
export interface ReleaseLockResult {
  released: boolean;
  reason: "RELEASED" | "NOT_FOUND" | "OWNER_MISMATCH" | "NOT_RUNNING";
  lock: ShopOperationLockSnapshot | null;
}

/** 心跳结果。 */
export interface HeartbeatLockResult {
  heartbeated: boolean;
  reason:
    | "HEARTBEATED"
    | "NOT_FOUND"
    | "OWNER_MISMATCH"
    | "NOT_RUNNING"
    | "ALREADY_EXPIRED";
  lock: ShopOperationLockSnapshot | null;
}

/** cleanup 返回值。 */
export interface CleanupExpiredLocksResult {
  cleanedCount: number;
}
