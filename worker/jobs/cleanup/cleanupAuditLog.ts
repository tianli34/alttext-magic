/**
 * File: worker/jobs/cleanup/cleanupAuditLog.ts
 * Purpose: 清理超过 90 天的审计日志。
 *          删除 created_at < NOW() - interval '90 days' 的记录，
 *          采用 LIMIT 1000 循环避免长事务。
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";

const log = createLogger({ module: "cleanup-audit-log" });

/** 每批删除行数上限 */
const BATCH_SIZE = 1000;

/** 保留天数 */
const RETENTION_DAYS = 90;

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
 * 批量删除超过 90 天的审计日志。
 *
 * ### SQL 策略
 * ```sql
 * DELETE FROM audit_log WHERE id IN (
 *   SELECT id FROM audit_log
 *   WHERE created_at < NOW() - interval '90 days'
 *   LIMIT 1000
 * )
 * ```
 * 依赖 `audit_log_created_at_idx` 索引（本 migration 新增）。
 *
 * @param client PrismaClient 实例
 * @returns 删除行数与耗时
 */
export async function cleanupAuditLog(client: PrismaClient): Promise<CleanupResult> {
  const start = Date.now();
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await client.$executeRaw`
      DELETE FROM audit_log WHERE id IN (
        SELECT id FROM audit_log
        WHERE created_at < NOW() - interval '${RETENTION_DAYS} days'
        LIMIT ${BATCH_SIZE}
      )
    `;
    totalDeleted += result;
    if (result < BATCH_SIZE) break;
  }

  const duration_ms = Date.now() - start;
  log.info({ deleted_rows: totalDeleted, duration_ms }, "cleanup-audit-log.done");
  return { task: "cleanupAuditLog", deleted_rows: totalDeleted, duration_ms };
}
