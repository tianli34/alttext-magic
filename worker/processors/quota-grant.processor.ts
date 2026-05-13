/**
 * File: worker/processors/quota-grant.processor.ts
 * Purpose: quota-grant 队列的 Job 处理器。
 *          从 BullMQ 消费 Free 月配额自动发放任务，
 *          调用 free-monthly-grant.service 执行批量发放逻辑。
 */

import { createLogger } from "../../server/utils/logger";
import { grantFreeMonthlyToAllShops } from "../../server/modules/billing/credit/free-monthly-grant.service";
import type { QuotaGrantJobData } from "../../server/queues/quota-grant.queue";

const logger = createLogger({ module: "quota-grant-processor" });

/**
 * 处理单个 quota-grant 任务。
 * 调用 grantFreeMonthlyToAllShops 为所有缺少当月 Free bucket 的店铺发放配额。
 */
export async function processQuotaGrantJob(data: QuotaGrantJobData): Promise<void> {
  const { source, targetMonth } = data;

  logger.info({ source, targetMonth }, "quota-grant.processor.start");

  try {
    const result = await grantFreeMonthlyToAllShops(targetMonth);

    logger.info(
      {
        source,
        targetMonth,
        totalFreeShops: result.totalFreeShops,
        grantedCount: result.grantedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
      },
      "quota-grant.processor.completed",
    );

    // 如果全部失败，抛出错误以触发 BullMQ 重试
    if (result.failedCount > 0 && result.grantedCount === 0 && result.totalFreeShops > 0) {
      throw new Error(
        `[quota-grant] 所有店铺发放失败 (failures: ${result.failedCount})`,
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
