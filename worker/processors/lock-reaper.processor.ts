/**
 * File: worker/processors/lock-reaper.processor.ts
 * Purpose: lock-reaper 队列的 BullMQ Worker 处理器。
 *          调用 reapExpiredLocks 回收心跳超时的锁。
 *
 * ### 幂等性
 * - reapExpiredLocks 内部使用 UPDATE ... WHERE status = 'RUNNING'，
 *   已 EXPIRED/RELEASED 的锁不会被重复处理。
 */

import { reapExpiredLocks } from "../jobs/lockReaper";
import { createLogger } from "../../server/utils/logger";
import type { LockReaperJobData } from "../../server/queues/lock-reaper.queue";

const logger = createLogger({ module: "lock-reaper-processor" });

/**
 * 处理单个 lock-reaper 任务。
 * 调用 reapExpiredLocks 回收心跳超时的锁。
 *
 * @param data 任务数据（包含 source）
 */
export async function processLockReaperJob(
  data: LockReaperJobData,
): Promise<void> {
  const { source } = data;

  logger.info({ source }, "lock-reaper.processor.start");

  const result = await reapExpiredLocks();

  logger.info(
    { source, reapedCount: result.reapedCount },
    "lock-reaper.processor.done",
  );
}
