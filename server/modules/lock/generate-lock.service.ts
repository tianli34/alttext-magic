/**
 * File: server/modules/lock/generate-lock.service.ts
 * Purpose: 提供 GENERATE 操作的锁封装。基于 Phase 4 的 shop-operation-lock。
 */
import {
  acquireLock,
  heartbeatLock,
  releaseLock,
} from "./operation-lock.service";
import type { AcquireLockResult, HeartbeatLockResult, ReleaseLockResult } from "./lock.types";

/**
 * 尝试获取 GENERATE 锁
 * 如果当前已存在 SCAN 或其他的 GENERATE 锁（非当前 batch），将返回冲突
 */
export async function acquireGenerateLock(
  shopId: string,
  batchId: string,
  ttlSeconds?: number,
): Promise<AcquireLockResult> {
  return acquireLock(shopId, "GENERATE", { batchId }, { ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined });
}

/**
 * 续期 GENERATE 锁
 */
export async function heartbeatGenerateLock(
  shopId: string,
  batchId: string,
  ttlSeconds?: number,
): Promise<HeartbeatLockResult> {
  return heartbeatLock(shopId, { batchId }, { ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined });
}

/**
 * 释放 GENERATE 锁
 */
export async function releaseGenerateLock(
  shopId: string,
  batchId: string,
): Promise<ReleaseLockResult> {
  return releaseLock(shopId, { batchId });
}
