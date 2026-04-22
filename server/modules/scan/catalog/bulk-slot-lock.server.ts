/**
 * File: server/modules/scan/catalog/bulk-slot-lock.server.ts
 * Purpose: 基于 Redis 提供 shop 级 Bulk 槽位补提交流程分布式锁。
 */
import { queueConnection } from "../../../queues/connection";

export const BULK_SLOT_LOCK_TTL_MS = 5_000;

function getBulkSlotLockKey(shopId: string): string {
  return `bulk_slot_lock:${shopId}`;
}

export async function acquireBulkSlotLock(
  shopId: string,
  ownerToken: string,
  ttlMs = BULK_SLOT_LOCK_TTL_MS,
): Promise<boolean> {
  const result = await queueConnection.set(
    getBulkSlotLockKey(shopId),
    ownerToken,
    "PX",
    ttlMs,
    "NX",
  );

  return result === "OK";
}

export async function releaseBulkSlotLock(
  shopId: string,
  ownerToken: string,
): Promise<boolean> {
  const released = await queueConnection.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    1,
    getBulkSlotLockKey(shopId),
    ownerToken,
  );

  return released === 1;
}
