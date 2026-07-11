/**
 * File: server/queues/gdpr-delete.queue.ts
 * Purpose: gdpr-delete 队列模块 —— 声明 Queue、JobData 接口与入队方法。
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { GDPR_DELETE_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
const logger = createLogger({ module: "gdpr-delete-queue" });
let _queue = null;
function getQueue() {
    if (!_queue) {
        _queue = new Queue(GDPR_DELETE_QUEUE_NAME, {
            connection: queueConnection,
        });
    }
    return _queue;
}
export function getGdprDeleteQueue() {
    return getQueue();
}
/**
 * 将 GDPR 删除任务入队。
 * 配置 3 次重试，指数退避初始延迟 10s。
 */
export async function enqueueGdprDelete(data) {
    const queue = getQueue();
    await queue.add("gdpr-delete", data, {
        jobId: `gdpr-delete:${data.shopId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
    });
    logger.info({ shopId: data.shopId, shopDomain: data.shopDomain, reason: data.reason }, "gdpr-delete.enqueue");
}
