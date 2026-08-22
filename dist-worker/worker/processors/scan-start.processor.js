/**
 * File: worker/processors/scan-start.processor.ts
 * Purpose: scan_start Job 处理器（薄壳）— 提交批量查询与进度更新全部由 service 编排。
 */
import { submitNextBatchAndNotify } from "../../server/modules/scan/catalog/scan-start.service";
export async function processScanStartJob(scanJobId) {
    await submitNextBatchAndNotify(scanJobId);
}
