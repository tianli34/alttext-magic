/**
 * File: server/queues/connection.ts
 * Purpose: Provide shared Redis/BullMQ connections for queue producers and workers.
 */
import IORedis from "ioredis";
import { env } from "../config/env.js";
const DEFAULT_REDIS_PORT = 6379;
function createRedisOptions(redisUrl) {
    const url = new URL(redisUrl);
    const isTls = url.protocol === "rediss:";
    const maxRetriesPerRequest = url.searchParams.get("maxRetriesPerRequest");
    return {
        maxRetriesPerRequest: maxRetriesPerRequest === null ? null : Number(maxRetriesPerRequest),
        enableReadyCheck: true,
        tls: isTls ? {} : undefined,
    };
}
export function createRedisConnection() {
    return new IORedis(env.REDIS_URL, createRedisOptions(env.REDIS_URL));
}
export const queueConnection = createRedisConnection();
queueConnection.on("error", () => {
    // BullMQ 会在调用点记录上下文，这里避免重复输出未结构化日志。
});
export function getRedisConnectionSummary() {
    const url = new URL(env.REDIS_URL);
    return {
        host: url.hostname,
        port: url.port ? Number(url.port) : DEFAULT_REDIS_PORT,
    };
}
