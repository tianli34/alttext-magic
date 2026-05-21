/**
 * File: server/queues/continuous-scan.types.ts
 * Purpose: continuous-scan 队列的三类 Job Payload 类型定义。
 */

/** 防抖/合并阶段 Job：收到 webhook 后先经该 Job 做窗口合并 */
export interface ContinuousScanDebouncePayload {
  shopId: string;
  topic: string;
  resourceId: string;
  latestWebhookEventId: string;
}

/** 产品增量扫描 Job：合并窗口结束后真正读取 product 图片指纹 */
export interface ContinuousScanProductPayload {
  shopId: string;
  productId: string;
  latestWebhookEventId: string;
}

/** 集合增量扫描 Job：合并窗口结束后真正读取 collection 图片指纹 */
export interface ContinuousScanCollectionPayload {
  shopId: string;
  collectionId: string;
  latestWebhookEventId: string;
}
