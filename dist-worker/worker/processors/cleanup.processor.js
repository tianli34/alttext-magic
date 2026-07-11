/**
 * File: worker/processors/cleanup.processor.ts
 * Purpose: Cleanup 队列的 Job Processor —— 接收 BullMQ Job，调用 runCleanupJob。
 */
import { runCleanupJob } from "../jobs/cleanup/cleanupJob.js";
/**
 * 处理 Cleanup Job。
 *
 * @param data BullMQ Job 的 data 部分
 */
export async function processCleanupJob(data) {
    await runCleanupJob(undefined, data.source);
}
