/**
 * File: worker/schedulers/scan-timeout.scheduler.ts
 * Purpose: 封装 RUNNING 扫描超时兜底巡检入口。
 */
import {
  timeoutStaleRunningScans,
} from "../../server/modules/scan/catalog/scan-timeout.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "scan-timeout-scheduler" });

/** 默认 cadence：1 分钟巡检一次。 */
export const DEFAULT_SCAN_TIMEOUT_SWEEP_INTERVAL_MS = 60 * 1000;

/** 运行一次 RUNNING 扫描超时清理。 */
export async function runScanTimeoutSweepOnce(): Promise<number> {
  const result = await timeoutStaleRunningScans();

  if (result.timedOutCount > 0) {
    logger.warn(result, "scan-timeout-scheduler.cleaned");
  }

  return result.timedOutCount;
}
