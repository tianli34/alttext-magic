/**
 * File: server/modules/lock/writeback-lock.service.ts
 * Purpose: 基于 Redis 提供 shop 级 WRITEBACK 写回锁。
 *
 * 实现约束：
 * - 锁 key: `shop:{shopId}:lock:writeback`
 * - value: UUID lockId，用于安全释放（仅持有者可释放）
 * - 默认 TTL: 5 分钟（可配置），防止死锁
 * - 使用 Redis `SET NX PX` 原子获取
 * - 释放时使用 Lua 脚本保证仅 lockId 匹配时才删除
 *
 * 互斥规则：
 * - 获取 WRITEBACK 锁前，检查 PG SCAN 锁是否存在 → 若存在则拒绝
 * - 获取 SCAN 锁前，检查 Redis WRITEBACK 锁是否存在 → 若存在则拒绝
 *   （此检查在 api.scan.start.tsx 中执行）
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { queueConnection } from "../../queues/connection";
import { isOperationRunning } from "./operation-lock.service";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "writeback-lock" });

/** 默认 TTL: 5 分钟 */
export const DEFAULT_WRITEBACK_LOCK_TTL_MS = 300_000;

/** WRITEBACK 锁 key 前缀 */
function getWritebackLockKey(shopId: string): string {
  return `shop:${shopId}:lock:writeback`;
}

/** 获取 WRITEBACK 锁结果 */
export interface AcquireWritebackLockResult {
  /** 是否获取成功 */
  acquired: boolean;
  /** 锁唯一标识（UUID），用于释放时验证持有者 */
  lockId: string;
  /** 获取失败原因 */
  reason?: "SCAN_LOCK_ACTIVE" | "ALREADY_LOCKED";
}

/**
 * Redis 客户端依赖接口，方便测试注入
 */
export interface RedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: unknown[]): Promise<unknown>;
}

/** 当前使用的 Redis 客户端（可测试时替换） */
let redisClient: RedisLike = queueConnection;

/**
 * 注入自定义 Redis 客户端（测试用）
 */
export function setWritebackLockRedis(client: RedisLike): void {
  redisClient = client;
}

/**
 * 重置为默认 Redis 客户端
 */
export function resetWritebackLockRedis(): void {
  redisClient = queueConnection;
}

/**
 * 获取 WRITEBACK 锁。
 *
 * 流程：
 * 1. 检查 PG 中是否存在活跃的 SCAN 锁 → 若存在则拒绝
 * 2. 使用 Redis SET NX PX 原子获取锁
 *
 * @param shopId 店铺 ID
 * @param ttlMs 锁 TTL（毫秒），默认 5 分钟
 * @returns 获取结果
 */
export async function acquireWritebackLock(
  shopId: string,
  ttlMs: number = DEFAULT_WRITEBACK_LOCK_TTL_MS,
): Promise<AcquireWritebackLockResult> {
  // 1. 检查 PG 中是否存在活跃的 SCAN 锁
  const scanRunning = await isOperationRunning(shopId, "SCAN");
  if (scanRunning) {
    logger.info({ shopId }, "writeback-lock.blocked-by-scan");
    return {
      acquired: false,
      lockId: "",
      reason: "SCAN_LOCK_ACTIVE",
    };
  }

  // 2. 尝试原子获取 Redis 锁
  const lockId = randomUUID();
  const key = getWritebackLockKey(shopId);
  const result = await redisClient.set(key, lockId, "PX", ttlMs, "NX");

  if (result !== "OK") {
    logger.info({ shopId }, "writeback-lock.already-locked");
    return {
      acquired: false,
      lockId: "",
      reason: "ALREADY_LOCKED",
    };
  }

  logger.info({ shopId, lockId, ttlMs }, "writeback-lock.acquired");
  return {
    acquired: true,
    lockId,
  };
}

/**
 * 释放 WRITEBACK 锁。
 *
 * 使用 Lua 脚本保证仅当 lockId 匹配时才删除，避免误删其他进程的锁。
 *
 * @param shopId 店铺 ID
 * @param lockId 获取锁时返回的 lockId
 */
export async function releaseWritebackLock(
  shopId: string,
  lockId: string,
): Promise<void> {
  const key = getWritebackLockKey(shopId);
  const released = await redisClient.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    1,
    key,
    lockId,
  );

  if (released === 1) {
    logger.info({ shopId, lockId }, "writeback-lock.released");
  } else {
    logger.warn({ shopId, lockId }, "writeback-lock.release-skipped");
  }
}

/**
 * 检查 WRITEBACK 锁是否存在。
 *
 * @param shopId 店铺 ID
 * @returns 是否被锁定
 */
export async function isWritebackLocked(shopId: string): Promise<boolean> {
  const key = getWritebackLockKey(shopId);
  const value = await redisClient.get(key);
  return value !== null && value !== undefined;
}
