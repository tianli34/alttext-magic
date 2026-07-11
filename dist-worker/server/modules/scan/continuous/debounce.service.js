import { queueConnection } from "../../../queues/connection";
import { createLogger } from "../../../utils/logger";
const logger = createLogger({ module: "debounce" });
let redisClient = queueConnection;
export function setDebounceRedis(client) {
    redisClient = client;
}
export function resetDebounceRedis() {
    redisClient = queueConnection;
}
export function key(shopId, topic, resourceId) {
    return `debounce:${shopId}:${topic}:${resourceId}`;
}
/**
 * 尝试获取 debounce key 的占有权（SET NX）。
 *
 * - 成功: 写入并返回 { acquired: true }
 * - 失败: 读取当前值返回 { acquired: false, previousWebhookEventId }
 */
export async function tryAcquire(shopId, topic, resourceId, webhookEventId, ttlSec = 60) {
    const k = key(shopId, topic, resourceId);
    const ok = await redisClient.set(k, webhookEventId, "EX", ttlSec, "NX");
    if (ok === "OK") {
        logger.debug({ shopId, topic, resourceId, ttlSec }, "debounce.acquired");
        return { acquired: true };
    }
    const previous = await redisClient.get(k);
    logger.debug({ shopId, topic, resourceId, previousWebhookEventId: previous }, "debounce.conflict");
    return { acquired: false, previousWebhookEventId: previous ?? undefined };
}
/**
 * 覆盖 value 并刷新 TTL（SET EX）。
 * key 不一定需要存在，不存在则新建。
 */
export async function update(shopId, topic, resourceId, newWebhookEventId, ttlSec = 60) {
    const k = key(shopId, topic, resourceId);
    await redisClient.set(k, newWebhookEventId, "EX", ttlSec);
    logger.debug({ shopId, topic, resourceId, ttlSec }, "debounce.updated");
}
/**
 * 读取并删除 key（GETDEL），返回最终 webhookEventId。
 * key 不存在时返回 null。
 */
export async function consume(shopId, topic, resourceId) {
    const k = key(shopId, topic, resourceId);
    const eventId = await redisClient.getdel(k);
    logger.debug({ shopId, topic, resourceId, eventId }, "debounce.consumed");
    return eventId;
}
