/**
 * File: app/lib/server/webhooks/webhook.queue.ts
 * Purpose: 将已持久化的 WebhookEvent 入列 BullMQ，供 Worker 异步消费。
 */
import { Queue } from "bullmq";
import { queueConnection } from "../../../../server/queues/connection";
import { WEBHOOK_QUEUE_NAME } from "../../../../server/config/queue-names";
import { createLogger } from "../../../../server/utils/logger";
const logger = createLogger({ module: "webhook-queue" });
/** 单例队列实例（懒初始化） */
let _queue = null;
function getQueue() {
    if (!_queue) {
        _queue = new Queue(WEBHOOK_QUEUE_NAME, {
            connection: queueConnection,
        });
    }
    return _queue;
}
/**
 * 将 WebhookEvent 入队。
 * 使用 eventId 作为 jobId 实现天然去重 —— BullMQ 相同 jobId 不会重复入队。
 */
export async function enqueueWebhookEvent(data) {
    const queue = getQueue();
    await queue.add("process", data, {
        jobId: data.webhookEventId,
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1_000 },
    });
    logger.info({ webhookEventId: data.webhookEventId }, "webhook.queue.enqueued");
}
