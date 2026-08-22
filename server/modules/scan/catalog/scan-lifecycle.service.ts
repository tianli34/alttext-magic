/**
 * File: server/modules/scan/catalog/scan-lifecycle.service.ts
 * Purpose: 扫描作业终态编排。所有 task 终态变化后均由此处决定发布、进度与锁的后续动作。
 */
import { enqueuePublishScanResult } from "../../../queues/publish-scan.queue";
import { setScanProgressStatus } from "../../../sse/progress-publisher";
import { releaseLockByType } from "../../lock/operation-lock.service";
import {
  finalizeScanJobIfTerminal,
  type FinalizeScanJobResult,
} from "./scan-task.service";

export async function reconcileScanJobLifecycle(input: {
  scanJobId: string;
  shopId: string;
}): Promise<FinalizeScanJobResult | null> {
  const result = await finalizeScanJobIfTerminal(input.scanJobId);

  if (!result?.transitioned) {
    return result;
  }

  await setScanProgressStatus(input.scanJobId, result.status);

  if (result.status === "FAILED") {
    await releaseLockByType(input.shopId, "SCAN");
    return result;
  }

  await enqueuePublishScanResult(input);
  return result;
}
