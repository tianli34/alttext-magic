/**
 * File: worker/processors/billing-sync.processor.ts
 * Purpose: billing-sync 队列的 Job 处理器。
 *          从 BullMQ 消费订阅同步任务，调用统一的 subscription.service。
 */

import { createLogger } from "../../server/utils/logger";
import { syncSubscriptionFromShopify } from "../../server/modules/billing/subscription.service";
import type { BillingSyncJobData } from "../../server/queues/billing-sync.queue";

const logger = createLogger({ module: "billing-sync-processor" });

/**
 * 处理单个 billing-sync 任务。
 * 调用统一的 syncSubscriptionFromShopify 同步服务。
 */
export async function processBillingSyncJob(data: BillingSyncJobData): Promise<void> {
  const { shopDomain, source } = data;

  logger.info({ shopDomain, source }, "billing-sync.processor.start");

  try {
    const result = await syncSubscriptionFromShopify(shopDomain);

    logger.info(
      {
        shopDomain,
        source,
        created: result.created,
        changed: result.changed,
        planCode: result.planCode,
        status: result.status,
      },
      "billing-sync.processor.completed",
    );
  } catch (error) {
    logger.error(
      { shopDomain, source, err: error },
      "billing-sync.processor.failed",
    );
    throw error;
  }
}
