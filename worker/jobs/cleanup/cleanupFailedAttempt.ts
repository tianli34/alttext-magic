/**
 * File: worker/jobs/cleanup/cleanupFailedAttempt.ts
 * Purpose: 清理超过 7 天的失败 ScanTaskAttempt 记录。
 *          删除 status = 'FAILED' 且 started_at < NOW() - interval '7 days' 的 attempt，
 *          采用 LIMIT 1000 循环避免长事务。级联删除关联 stg_* 行。
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";

const log = createLogger({ module: "cleanup-failed-attempt" });

/** 每批删除行数上限 */
const BATCH_SIZE = 1000;

/** 保留天数 */
const RETENTION_DAYS = 7;

/** 单次子任务执行结果 */
export interface CleanupResult {
  /** 子任务名称 */
  task: string;
  /** 总删除行数 */
  deleted_rows: number;
  /** 执行耗时（毫秒） */
  duration_ms: number;
}

/**
 * 批量删除超过 7 天的失败 ScanTaskAttempt 记录。
 *
 * ### SQL 策略
 * ```sql
 * DELETE FROM scan_task_attempt WHERE id IN (
 *   SELECT id FROM scan_task_attempt
 *   WHERE status = 'FAILED'
 *     AND started_at < NOW() - interval '7 days'
 *   LIMIT 1000
 * )
 * ```
 * - 依赖 `scan_task_attempt_shop_id_status_started_at_idx` 复合索引。
 * - FK CASCADE 自动清理关联的 stg_* 行。
 *
 * @param client PrismaClient 实例
 * @returns 删除行数与耗时
 */
export async function cleanupFailedAttempt(client: PrismaClient): Promise<CleanupResult> {
  const start = Date.now();
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await client.$executeRaw`
      DELETE FROM scan_task_attempt WHERE id IN (
        SELECT id FROM scan_task_attempt
        WHERE status = 'FAILED'
          AND started_at < NOW() - interval '${RETENTION_DAYS} days'
        LIMIT ${BATCH_SIZE}
      )
    `;
    totalDeleted += result;
    if (result < BATCH_SIZE) break;
  }

  const duration_ms = Date.now() - start;
  log.info({ deleted_rows: totalDeleted, duration_ms }, "cleanup-failed-attempt.done");
  return { task: "cleanupFailedAttempt", deleted_rows: totalDeleted, duration_ms };
}
