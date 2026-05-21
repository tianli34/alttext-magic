/**
 * File: server/modules/scan/continuous/debounce.service.ts
 * Purpose: 封装 debounce key 的读/写/更新逻辑，用于合并窗口期内重复 webhook 事件。
 *
 * Key 格式: debounce:{shopId}:{topic}:{resourceId}
 * Value: webhookEventId
 * TTL: 合并窗口期，默认 60 秒
 */
import type { Redis } from "ioredis";
import { queueConnection } from "../../../queues/connection";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "debounce" });

/** Redis 客户端接口（可 mock） */
export interface RedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

let redisClient: RedisLike = queueConnection;

export function setDebounceRedis(client: RedisLike): void {
  redisClient = client;
}

export function resetDebounceRedis(): void {
  redisClient = queueConnection;
}

export function key(
  shopId: string,
  topic: string,
  resourceId: string,
): string {
  return `debounce:${shopId}:${topic}:${resourceId}`;
}

export interface TryAcquireResult {
  acquired: boolean;
  previousWebhookEventId?: string;
}

/**
 * 尝试获取 debounce key 的占有权（SET NX）。
 *
 * - 成功: 写入并返回 { acquired: true }
 * - 失败: 读取当前值返回 { acquired: false, previousWebhookEventId }
 */
export async function tryAcquire(
  shopId: string,
  topic: string,
  resourceId: string,
  webhookEventId: string,
  ttlSec: number = 60,
): Promise<TryAcquireResult> {
  const k = key(shopId, topic, resourceId);
  const ok = await redisClient.set(k, webhookEventId, "EX", ttlSec, "NX");

  if (ok === "OK") {
    logger.debug({ shopId, topic, resourceId, ttlSec }, "debounce.acquired");
    return { acquired: true };
  }

  const previous = await redisClient.get(k);
  logger.debug(
    { shopId, topic, resourceId, previousWebhookEventId: previous },
    "debounce.conflict",
  );
  return { acquired: false, previousWebhookEventId: previous ?? undefined };
}

/**
 * 覆盖 value 并刷新 TTL（SET EX）。
 * key 不一定需要存在，不存在则新建。
 */
export async function update(
  shopId: string,
  topic: string,
  resourceId: string,
  newWebhookEventId: string,
  ttlSec: number = 60,
): Promise<void> {
  const k = key(shopId, topic, resourceId);
  await redisClient.set(k, newWebhookEventId, "EX", ttlSec);
  logger.debug({ shopId, topic, resourceId, ttlSec }, "debounce.updated");
}

/**
 * 读取并删除 key（GETDEL），返回最终 webhookEventId。
 * key 不存在时返回 null。
 */
export async function consume(
  shopId: string,
  topic: string,
  resourceId: string,
): Promise<string | null> {
  const k = key(shopId, topic, resourceId);
  const eventId = await redisClient.getdel(k);
  logger.debug({ shopId, topic, resourceId, eventId }, "debounce.consumed");
  return eventId;
}
