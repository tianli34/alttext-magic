/**
 * File: worker/schedulers/discovery-progress.scheduler.ts
 * Purpose: 封装发现阶段 objectCount 采集巡检入口。
 *          较高频率（默认 10 秒）轮询处于发现阶段的 bulk operation，
 *          将 objectCount 聚合写入 Redis，驱动前端不确定进度计数。
 */
import { pollDiscoveryObjectCounts } from "../../server/modules/scan/catalog/discovery-progress.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "discovery-progress-scheduler" });

/** 默认 cadence：10 秒巡检一次，兼顾计数实时性与 Shopify 成本限流。 */
export const DEFAULT_DISCOVERY_PROGRESS_INTERVAL_MS = 10 * 1000;

/** 运行一次发现阶段 objectCount 采集。 */
export async function runDiscoveryProgressPollOnce(): Promise<number> {
  const result = await pollDiscoveryObjectCounts();

  if (result.updatedJobCount > 0 || result.errorCount > 0) {
    logger.info(result, "discovery-progress.swept");
  }

  return result.checkedAttemptCount;
}
