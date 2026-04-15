/**
 * File: server/modules/lock/operation-lock.service.ts
 * Purpose: 提供 shop 级互斥锁服务，统一封装原始 SQL 与事务。
 *
 * 实现约束：
 * - 表：`shop_operation_lock`
 * - 唯一键：`shop_id`
 * - 读取既有锁时使用事务内 `SELECT ... FOR UPDATE`
 * - 默认 TTL：30 分钟
 *
 * 当前 owner 语义：
 * - 由于 schema 仅有 `batch_id` 字段，本服务以 `batchId` 判定同一 owner。
 */
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
const logger = createLogger({ module: "shop-operation-lock" });
/** 默认 30 分钟超时。 */
export const DEFAULT_OPERATION_LOCK_TTL_MS = 30 * 60 * 1000;
/**
 * 获取 shop 锁。
 *
 * 规则：
 * - 无记录：创建并持有
 * - 同 owner + 同类型重试：幂等刷新 TTL
 * - 已释放 / 已过期：回收并重置为新锁
 * - 其他 RUNNING 锁：返回冲突
 */
export async function acquireLock(shopId, operationType, owner, options) {
    const ttlMs = normalizeTtlMs(options?.ttlMs);
    return prisma.$transaction(async (tx) => {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        const existingLock = await selectLockForUpdate(tx, shopId);
        if (existingLock === null) {
            const insertedLock = await insertLock(tx, {
                shopId,
                operationType,
                batchId: owner.batchId,
                acquiredAt: now,
                heartbeatAt: now,
                expiresAt,
            });
            if (insertedLock !== null) {
                logger.info({ shopId, operationType, batchId: owner.batchId, expiresAt }, "Operation lock acquired by insert");
                return {
                    acquired: true,
                    mode: "CREATED",
                    lock: insertedLock,
                };
            }
            // 并发场景下，可能在本事务 select 之后被其他事务抢先插入。
            const concurrentLock = await selectLockForUpdate(tx, shopId);
            if (concurrentLock === null) {
                throw new Error("Failed to insert or reload shop operation lock");
            }
            return handleExistingLock(tx, concurrentLock, {
                shopId,
                operationType,
                owner,
                now,
                expiresAt,
            });
        }
        return handleExistingLock(tx, existingLock, {
            shopId,
            operationType,
            owner,
            now,
            expiresAt,
        });
    });
}
/**
 * 释放锁。
 *
 * 仅允许当前 owner 释放自身持有的 RUNNING 锁。
 */
export async function releaseLock(shopId, owner) {
    return prisma.$transaction(async (tx) => {
        const currentLock = await selectLockForUpdate(tx, shopId);
        if (currentLock === null) {
            return {
                released: false,
                reason: "NOT_FOUND",
                lock: null,
            };
        }
        if (currentLock.status !== "RUNNING") {
            return {
                released: false,
                reason: "NOT_RUNNING",
                lock: currentLock,
            };
        }
        if (!isSameOwner(currentLock, owner)) {
            return {
                released: false,
                reason: "OWNER_MISMATCH",
                lock: currentLock,
            };
        }
        const releasedAt = new Date();
        const releasedLock = await updateLock(tx, {
            shopId,
            operationType: currentLock.operationType,
            batchId: currentLock.batchId,
            acquiredAt: currentLock.acquiredAt,
            heartbeatAt: releasedAt,
            expiresAt: releasedAt,
            releasedAt,
            status: "RELEASED",
        });
        logger.info({ shopId, batchId: owner.batchId, operationType: currentLock.operationType }, "Operation lock released");
        return {
            released: true,
            reason: "RELEASED",
            lock: releasedLock,
        };
    });
}
/**
 * 锁心跳。
 *
 * 仅允许当前 owner 为仍处于 RUNNING 且未过期的锁续租。
 */
export async function heartbeatLock(shopId, owner, options) {
    const ttlMs = normalizeTtlMs(options?.ttlMs);
    return prisma.$transaction(async (tx) => {
        const currentLock = await selectLockForUpdate(tx, shopId);
        if (currentLock === null) {
            return {
                heartbeated: false,
                reason: "NOT_FOUND",
                lock: null,
            };
        }
        if (currentLock.status !== "RUNNING") {
            return {
                heartbeated: false,
                reason: "NOT_RUNNING",
                lock: currentLock,
            };
        }
        if (!isSameOwner(currentLock, owner)) {
            return {
                heartbeated: false,
                reason: "OWNER_MISMATCH",
                lock: currentLock,
            };
        }
        const now = new Date();
        if (currentLock.expiresAt.getTime() <= now.getTime()) {
            return {
                heartbeated: false,
                reason: "ALREADY_EXPIRED",
                lock: currentLock,
            };
        }
        const heartbeatedLock = await updateLock(tx, {
            shopId,
            operationType: currentLock.operationType,
            batchId: currentLock.batchId,
            acquiredAt: currentLock.acquiredAt,
            heartbeatAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
            releasedAt: null,
            status: "RUNNING",
        });
        logger.info({
            shopId,
            batchId: owner.batchId,
            operationType: currentLock.operationType,
            expiresAt: heartbeatedLock.expiresAt,
        }, "Operation lock heartbeat refreshed");
        return {
            heartbeated: true,
            reason: "HEARTBEATED",
            lock: heartbeatedLock,
        };
    });
}
/**
 * 回收所有已过期但仍标记为 RUNNING 的锁。
 */
export async function cleanupExpiredLocks() {
    const cleanedRows = await prisma.$queryRaw(Prisma.sql `
    UPDATE "shop_operation_lock"
    SET
      "status" = 'EXPIRED',
      "released_at" = CURRENT_TIMESTAMP
    WHERE
      "status" = 'RUNNING'
      AND "expires_at" <= CURRENT_TIMESTAMP
    RETURNING "shop_id"
  `);
    if (cleanedRows.length > 0) {
        logger.warn({
            cleanedCount: cleanedRows.length,
            shopIds: cleanedRows.map((row) => row.shop_id),
        }, "Expired operation locks cleaned up");
    }
    return { cleanedCount: cleanedRows.length };
}
async function handleExistingLock(tx, currentLock, input) {
    const { shopId, operationType, owner, now, expiresAt } = input;
    const isExpired = currentLock.expiresAt.getTime() <= now.getTime();
    if (currentLock.status === "RUNNING" &&
        !isExpired &&
        isSameOwner(currentLock, owner) &&
        currentLock.operationType === operationType) {
        const refreshedLock = await updateLock(tx, {
            shopId,
            operationType,
            batchId: owner.batchId,
            acquiredAt: currentLock.acquiredAt,
            heartbeatAt: now,
            expiresAt,
            releasedAt: null,
            status: "RUNNING",
        });
        logger.info({ shopId, operationType, batchId: owner.batchId, expiresAt }, "Operation lock refreshed by same owner");
        return {
            acquired: true,
            mode: "REFRESHED",
            lock: refreshedLock,
        };
    }
    if (currentLock.status === "RUNNING" && !isExpired) {
        return {
            acquired: false,
            mode: "CONFLICT",
            lock: currentLock,
        };
    }
    const reclaimedLock = await updateLock(tx, {
        shopId,
        operationType,
        batchId: owner.batchId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
        releasedAt: null,
        status: "RUNNING",
    });
    logger.info({ shopId, operationType, batchId: owner.batchId, previousStatus: currentLock.status }, "Operation lock reclaimed");
    return {
        acquired: true,
        mode: "RECLAIMED",
        lock: reclaimedLock,
    };
}
async function selectLockForUpdate(tx, shopId) {
    const rows = await tx.$queryRaw(Prisma.sql `
    SELECT
      "shop_id",
      "lock_type",
      "batch_id",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
      "released_at",
      "status"
    FROM "shop_operation_lock"
    WHERE "shop_id" = ${shopId}
    FOR UPDATE
  `);
    const row = rows[0];
    return row ? mapRowToSnapshot(row) : null;
}
async function insertLock(tx, input) {
    const rows = await tx.$queryRaw(Prisma.sql `
    INSERT INTO "shop_operation_lock" (
      "shop_id",
      "lock_type",
      "batch_id",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
      "released_at",
      "status"
    )
    VALUES (
      ${input.shopId},
      ${input.operationType},
      ${input.batchId},
      ${input.acquiredAt},
      ${input.heartbeatAt},
      ${input.expiresAt},
      ${input.releasedAt ?? null},
      ${input.status ?? "RUNNING"}
    )
    ON CONFLICT ("shop_id") DO NOTHING
    RETURNING
      "shop_id",
      "lock_type",
      "batch_id",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
      "released_at",
      "status"
  `);
    const row = rows[0];
    return row ? mapRowToSnapshot(row) : null;
}
async function updateLock(tx, input) {
    const rows = await tx.$queryRaw(Prisma.sql `
    UPDATE "shop_operation_lock"
    SET
      "lock_type" = ${input.operationType},
      "batch_id" = ${input.batchId},
      "acquired_at" = ${input.acquiredAt},
      "heartbeat_at" = ${input.heartbeatAt},
      "expires_at" = ${input.expiresAt},
      "released_at" = ${input.releasedAt ?? null},
      "status" = ${input.status ?? "RUNNING"}
    WHERE "shop_id" = ${input.shopId}
    RETURNING
      "shop_id",
      "lock_type",
      "batch_id",
      "acquired_at",
      "heartbeat_at",
      "expires_at",
      "released_at",
      "status"
  `);
    const row = rows[0];
    if (!row) {
        throw new Error(`Operation lock update failed for shop ${input.shopId}`);
    }
    return mapRowToSnapshot(row);
}
function mapRowToSnapshot(row) {
    return {
        shopId: row.shop_id,
        operationType: parseOperationType(row.lock_type),
        batchId: row.batch_id,
        acquiredAt: row.acquired_at,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
        releasedAt: row.released_at,
        status: parseLockStatus(row.status),
    };
}
function parseOperationType(value) {
    if (value === "SCAN" || value === "GENERATE" || value === "WRITEBACK") {
        return value;
    }
    throw new Error(`Unexpected shop operation lock_type: ${value}`);
}
function parseLockStatus(value) {
    if (value === "RUNNING" || value === "RELEASED" || value === "EXPIRED") {
        return value;
    }
    throw new Error(`Unexpected shop operation lock status: ${value}`);
}
function normalizeTtlMs(ttlMs) {
    const normalized = ttlMs ?? DEFAULT_OPERATION_LOCK_TTL_MS;
    if (!Number.isFinite(normalized) || normalized <= 0) {
        throw new Error("Operation lock ttlMs must be a positive finite number");
    }
    return normalized;
}
function isSameOwner(lock, owner) {
    return lock.batchId === owner.batchId;
}
