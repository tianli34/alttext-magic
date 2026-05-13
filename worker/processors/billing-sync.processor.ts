/**
 * File: worker/processors/billing-sync.processor.ts
 * Purpose: billing-sync 队列的 Job 处理器。
 *          支持两种模式：
 *          - 单 shop 模式：shopDomain 存在时，调用统一的 subscription.service 同步。
 *          - 批量模式：shopDomain 为空时，调用 syncAllShopsBilling 批量同步所有店铺。
 */

import { createLogger } from "../../server/utils/logger";
import { syncSubscriptionFromShopify } from "../../server/modules/billing/subscription.service";
import { syncAllShopsBilling } from "../jobs/billing-sync.job";
import type { BillingSyncJobData } from "../../server/queues/billing-sync.queue";

const logger = createLogger({ module: "billing-sync-processor" });

/**
 * 处理 billing-sync 任务。
 * 根据 shopDomain 是否存在，分发到单 shop 同步或批量同步。
 */
export async function processBillingSyncJob(data: BillingSyncJobData): Promise<void> {
  const { shopDomain, source } = data;

  // ---- 批量模式：shopDomain 为空时同步所有店铺 ----
  if (!shopDomain) {
    logger.info({ source }, "billing-sync.processor.batch.start");

    const result = await syncAllShopsBilling();

    logger.info(
      {
        source,
        total: result.total,
        synced: result.synced,
        changed: result.changed,
        applied: result.applied,
        failed: result.failed,
      },
      "billing-sync.processor.batch.completed",
    );
    return;
  }

  // ---- 单 shop 模式 ----
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
