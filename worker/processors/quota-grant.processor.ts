/**
 * File: worker/processors/quota-grant.processor.ts
 * Purpose: quota-grant 队列的 Job 处理器。
 *          从 BullMQ 消费月度配额自动发放任务：
 *          1. Free 月配额：调用 free-monthly-grant.service 批量发放；
 *          2. 付费 included 配额：调用 paid-included-grant.service 周期性续发
 *             （月付按自然月补发、年付按订阅周期窗口补发，修复付费配额永不续期问题）。
 */

import { createLogger } from "../../server/utils/logger";
import { grantFreeMonthlyToAllShops } from "../../server/modules/billing/credit/free-monthly-grant.service";
import { grantPaidIncludedToAllSubscriptions } from "../../server/modules/billing/credit/paid-included-grant.service";
import type { QuotaGrantJobData } from "../../server/queues/quota-grant.queue";

const logger = createLogger({ module: "quota-grant-processor" });

/**
 * 处理单个 quota-grant 任务。
 * 1. 调用 grantFreeMonthlyToAllShops 为所有缺少当月 Free bucket 的店铺发放配额；
 * 2. 调用 grantPaidIncludedToAllSubscriptions 为付费订阅续发 included 配额。
 */
export async function processQuotaGrantJob(data: QuotaGrantJobData): Promise<void> {
  const { source, targetMonth } = data;

  logger.info({ source, targetMonth }, "quota-grant.processor.start");

  try {
    // ---- 1. Free 月配额发放 ----
    const freeResult = await grantFreeMonthlyToAllShops(targetMonth);

    logger.info(
      {
        source,
        targetMonth,
        totalFreeShops: freeResult.totalFreeShops,
        grantedCount: freeResult.grantedCount,
        skippedCount: freeResult.skippedCount,
        failedCount: freeResult.failedCount,
      },
      "quota-grant.processor.free-grant.completed",
    );

    // 如果 Free 发放全部失败，抛出错误以触发 BullMQ 重试
    if (
      freeResult.failedCount > 0 &&
      freeResult.grantedCount === 0 &&
      freeResult.totalFreeShops > 0
    ) {
      throw new Error(
        `[quota-grant] Free 配额所有店铺发放失败 (failures: ${freeResult.failedCount})`,
      );
    }

    // ---- 2. 付费 included 配额续发 ----
    const paidResult = await grantPaidIncludedToAllSubscriptions(targetMonth);

    logger.info(
      {
        source,
        targetMonth,
        totalPaidSubscriptions: paidResult.totalPaidSubscriptions,
        grantedCount: paidResult.grantedCount,
        skippedCount: paidResult.skippedCount,
        failedCount: paidResult.failedCount,
      },
      "quota-grant.processor.paid-grant.completed",
    );

    // 如果付费续发全部失败，同样抛出错误以触发 BullMQ 重试
    if (
      paidResult.failedCount > 0 &&
      paidResult.grantedCount === 0 &&
      paidResult.totalPaidSubscriptions > 0
    ) {
      throw new Error(
        `[quota-grant] 付费 included 配额所有订阅续发失败 (failures: ${paidResult.failedCount})`,
      );
    }
  } catch (error) {
    logger.error(
      { source, targetMonth, err: error },
      "quota-grant.processor.failed",
    );
    throw error;
  }
}
