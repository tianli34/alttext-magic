/**
 * File: worker/schedulers/lock-timeout.scheduler.ts
 * Purpose: 封装 shop_operation_lock 超时回收任务入口。
 */
import {
  cleanupExpiredLocks,
} from "../../server/modules/lock/operation-lock.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "lock-timeout-scheduler" });

/** 默认建议 cadence：1 分钟巡检一次。 */
export const DEFAULT_LOCK_TIMEOUT_CLEANUP_INTERVAL_MS = 60 * 1000;

/** 复用 service 层回收逻辑，避免 SQL 散落到 route / scheduler。 */
export async function runLockTimeoutCleanupOnce(): Promise<number> {
  const result = await cleanupExpiredLocks();

  if (result.cleanedCount > 0) {
    logger.warn(
      { cleanedCount: result.cleanedCount },
      "Lock timeout cleanup reclaimed expired locks",
    );
  }

  return result.cleanedCount;
}
