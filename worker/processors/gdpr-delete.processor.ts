/**
 * File: worker/processors/gdpr-delete.processor.ts
 * Purpose: gdpr-delete 队列的 Job Processor —— 接收 BullMQ Job，调用 runGdprDeleteJob。
 */

import type { GdprDeleteJobData } from "../../server/queues/gdpr-delete.queue.js";
import { runGdprDeleteJob } from "../jobs/gdpr/gdprDelete.js";

/**
 * 处理 GDPR 数据清理 Job。
 *
 * @param data BullMQ Job 的 data 部分
 */
export async function processGdprDeleteJob(data: GdprDeleteJobData): Promise<void> {
  await runGdprDeleteJob(data);
}
