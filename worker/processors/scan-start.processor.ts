/**
 * File: worker/processors/scan-start.processor.ts
 * Purpose: scan_start Job 处理器: 提交批量查询并更新进度阶段。
 */
import { trySubmitNextBatch } from "../../server/modules/scan/catalog/scan-start.service";
import { updateScanProgressPhase } from "../../server/sse/progress-publisher";
import { SCAN_PHASE } from "../../server/modules/scan/scan.constants";

interface ScanStartProcessorDependencies {
  trySubmitNextBatch: typeof trySubmitNextBatch;
}

const defaultDependencies: ScanStartProcessorDependencies = {
  trySubmitNextBatch,
};

const scanStartProcessorDependencies: ScanStartProcessorDependencies = {
  ...defaultDependencies,
};

export function setScanStartProcessorDependenciesForTests(
  overrides: Partial<ScanStartProcessorDependencies>,
): void {
  Object.assign(scanStartProcessorDependencies, overrides);
}

export function resetScanStartProcessorDependenciesForTests(): void {
  Object.assign(scanStartProcessorDependencies, defaultDependencies);
}

export async function processScanStartJob(scanJobId: string): Promise<void> {
  await scanStartProcessorDependencies.trySubmitNextBatch(scanJobId);
  // 批量查询已提交，更新进度阶段
  await updateScanProgressPhase(
    scanJobId,
    SCAN_PHASE.BULK_SUBMITTED,
    "批量查询已提交，等待 Shopify 返回数据…",
  );
}
