/**
 * File: server/queues/gdpr-delete.queue.ts
 * Purpose: gdpr-delete 队列模块 —— 声明 Queue、JobData 接口与入队方法。
 */

import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { GDPR_DELETE_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "gdpr-delete-queue" });

/** GDPR 删除原因 */
export type GdprDeleteReason = "APP_UNINSTALLED" | "SHOP_REDACT";

/** gdpr-delete Job 的入参数据 */
export interface GdprDeleteJobData {
  /** 店铺 ID（shops.id） */
  shopId: string;
  /** 店铺域名（用于匹配 Session、WebhookEvent 等无 shop_id 字段的表） */
  shopDomain: string;
  /** 触发原因：APP_UNINSTALLED（应用卸载）或 SHOP_REDACT（店铺数据删除请求） */
  reason: GdprDeleteReason;
  /** 来源标识（如 webhook topic） */
  source: string;
}

let _queue: Queue<GdprDeleteJobData> | null = null;

function getQueue(): Queue<GdprDeleteJobData> {
  if (!_queue) {
    _queue = new Queue<GdprDeleteJobData>(GDPR_DELETE_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

export function getGdprDeleteQueue(): Queue<GdprDeleteJobData> {
  return getQueue();
}

/**
 * 将 GDPR 删除任务入队。
 * 配置 3 次重试，指数退避初始延迟 10s。
 */
export async function enqueueGdprDelete(data: GdprDeleteJobData): Promise<void> {
  const queue = getQueue();
  await queue.add("gdpr-delete", data, {
    jobId: `gdpr-delete:${data.shopId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
  logger.info(
    { shopId: data.shopId, shopDomain: data.shopDomain, reason: data.reason },
    "gdpr-delete.enqueue",
  );
}
