/**
 * File: worker/schedulers/bulk-attempt-reaper.scheduler.ts
 * Purpose: 封装 scan_task_attempt 维度 Shopify 对账巡检入口。
 */
import { reapStuckBulkAttempts } from "../../server/modules/scan/catalog/bulk-attempt-reaper.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "bulk-attempt-reaper-scheduler" });

/** 默认 cadence：1 分钟巡检一次。 */
export const DEFAULT_BULK_ATTEMPT_REAPER_INTERVAL_MS = 60 * 1000;

/** 运行一次 scan_task_attempt 维度对账。 */
export async function runBulkAttemptReaperOnce(): Promise<number> {
  const result = await reapStuckBulkAttempts();

  if (
    result.convergedCount > 0 ||
    result.failedCount > 0 ||
    result.errorCount > 0
  ) {
    logger.info(result, "bulk-attempt-reaper.swept");
  }

  return result.checkedCount;
}
