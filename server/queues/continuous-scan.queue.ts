/**
 * File: server/queues/continuous-scan.queue.ts
 * Purpose: continuous-scan 队列生产者。
 *          统一管理三类增量扫描 Job 的入队：
 *          - continuous_scan_debounce：webhook 事件防抖合并
 *          - continuous_scan_product：产品增量扫描
 *          - continuous_scan_collection：集合增量扫描
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { CONTINUOUS_SCAN_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import type {
  ContinuousScanDebouncePayload,
  ContinuousScanProductPayload,
  ContinuousScanCollectionPayload,
} from "./continuous-scan.types";

const logger = createLogger({ module: "continuous-scan-queue" });

/** 将字符串中的特殊字符替换为下划线，保证 jobId 不含 BullMQ 禁止的 : */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 单例队列实例（懒初始化），运行时实际为同一 Queue */
let _queue: Queue<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
> | null = null;

function getQueue(): Queue<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
> {
  if (!_queue) {
    _queue = new Queue(CONTINUOUS_SCAN_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

/**
 * 获取队列实例（供 scheduler / worker 注册使用）。
 */
export function getContinuousScanQueue(): Queue<
  ContinuousScanDebouncePayload | ContinuousScanProductPayload | ContinuousScanCollectionPayload
> {
  return getQueue();
}

// ---- Job 名称常量 ----

export const JOB_DEBOUNCE = "continuous_scan_debounce";
export const JOB_PRODUCT = "continuous_scan_product";
export const JOB_COLLECTION = "continuous_scan_collection";

// ---- 入队工具函数 ----

/**
 * 将 webhook 事件入列防抖合并阶段。
 * jobId 按 (shopId, topic, resourceId) 去重，窗口内的重复事件自动 coalesce。
 * BullMQ v5 对相同 jobId 的 add 不会更新 data，故先移除旧 job 再入新 job，
 * 确保 payload 中的 latestWebhookEventId 始终指向最新事件。
 */
export async function enqueueDebounceJob(
  data: ContinuousScanDebouncePayload,
): Promise<void> {
  const queue = getQueue();
  const jobId = `debounce_${safe(data.shopId)}_${safe(data.topic)}_${safe(data.resourceId)}`;

  const existing = await queue.getJob(jobId);
  if (existing) {
    await existing.remove();
  }

  await queue.add(JOB_DEBOUNCE, data, {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  });

  logger.info(
    { shopId: data.shopId, topic: data.topic, resourceId: data.resourceId },
    "continuous-scan.queue.debounce.enqueued",
  );
}

/**
 * 将产品增量扫描任务入列。
 * jobId 按 (shopId, productId) 去重，防止同一产品并发扫描。
 */
export async function enqueueProductScan(
  data: ContinuousScanProductPayload,
): Promise<void> {
  const queue = getQueue();

  await queue.add(JOB_PRODUCT, data, {
    jobId: `product_${safe(data.shopId)}_${safe(data.productId)}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  });

  logger.info(
    { shopId: data.shopId, productId: data.productId },
    "continuous-scan.queue.product.enqueued",
  );
}

/**
 * 将集合增量扫描任务入列。
 * jobId 按 (shopId, collectionId) 去重，防止同一集合并发扫描。
 */
export async function enqueueCollectionScan(
  data: ContinuousScanCollectionPayload,
): Promise<void> {
  const queue = getQueue();

  await queue.add(JOB_COLLECTION, data, {
    jobId: `collection_${safe(data.shopId)}_${safe(data.collectionId)}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  });
logger.info(
  { shopId: data.shopId, collectionId: data.collectionId },
  "continuous-scan.queue.collection.enqueued",
);
}

/**
* 将 debounce 防抖合并 Job 入列（带延迟）。
* 仅在 tryAcquire 成功（首次 webhook）时调用。
* jobId 按 (shopId, topic, resourceId) 去重，60s 延迟后触发。
* Worker 触发时通过 debounce.consume() 读取最新 webhookEventId。
*/
export async function enqueueDebounceDelayedJob(
data: ContinuousScanDebouncePayload,
delayMs: number,
): Promise<void> {
const queue = getQueue();
const jobId = `debounce_${safe(data.shopId)}_${safe(data.topic)}_${safe(data.resourceId)}`;

// 安全清理：若存在旧 job（理论上 tryAcquire 成功时不应有），先移除
const existing = await queue.getJob(jobId);
if (existing) {
  await existing.remove();
}

await queue.add(JOB_DEBOUNCE, data, {
  jobId,
  delay: delayMs,
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 2_000 },
});

logger.info(
  {
    shopId: data.shopId,
    topic: data.topic,
    resourceId: data.resourceId,
    delayMs,
  },
  "continuous-scan.queue.debounce_delayed.enqueued",
);
}
