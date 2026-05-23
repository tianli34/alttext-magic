/**
 * File: worker/jobs/cleanup/cleanupStaging.ts
 * Purpose: 清理 staging 表（stg_*）与 scan_result 表中超过 7 天的数据。
 *          - staging: 已完成/失败 attempt 关联的 stg_* 行
 *          - scan_result: 已完成 ScanJob 关联的 scan_result_usage + scan_result_target 行
 *          采用 LIMIT 1000 循环避免长事务。
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";

const log = createLogger({ module: "cleanup-staging" });

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
 * 对指定表执行基于条件的批量删除，每批最多 BATCH_SIZE 行。
 *
 * @param client   PrismaClient 实例
 * @param table    目标表名
 * @param whereSql WHERE 子句（不含 WHERE 关键字）
 * @returns 该表累计删除行数
 */
async function batchDelete(
  client: PrismaClient,
  table: string,
  whereSql: string,
): Promise<number> {
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 使用 Prisma.raw 执行动态 SQL（表名/条件无法参数化）
    const result = await client.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE ${whereSql} LIMIT ${BATCH_SIZE}
      )`,
    );
    totalDeleted += result;
    if (result < BATCH_SIZE) break;
  }

  return totalDeleted;
}

/**
 * 清理 staging 表与 scan_result 表中超过 7 天的数据。
 *
 * ### Staging 清理策略
 * 对于每个 stg_* 表，删除关联到已终结（SUCCESS/FAILED）且 started_at > 7 天的 attempt 的行：
 * ```sql
 * DELETE FROM stg_product WHERE id IN (
 *   SELECT sp.id FROM stg_product sp
 *   JOIN scan_task_attempt sta ON sp.scan_task_attempt_id = sta.id
 *   WHERE sta.status IN ('SUCCESS','FAILED')
 *     AND sta.started_at < NOW() - interval '7 days'
 *   LIMIT 1000
 * )
 * ```
 *
 * ### scan_result 清理策略
 * 删除关联到已完成 ScanJob（finished_at IS NOT NULL 且 finished_at < 7 天前）的行：
 * - 先删 scan_result_usage（外键依赖）
 * - 再删 scan_result_target
 *
 * @param client PrismaClient 实例
 * @returns 删除行数与耗时
 */
export async function cleanupStaging(client: PrismaClient): Promise<CleanupResult> {
  const start = Date.now();
  let totalDeleted = 0;

  // ---- staging 表清理 ----
  const stgTables = [
    "stg_product",
    "stg_media_image_product",
    "stg_media_image_file",
    "stg_collection",
    "stg_article",
  ];

  const stgWhere = [
    `scan_task_attempt_id IN (`,
    `  SELECT sta.id FROM scan_task_attempt sta`,
    `  WHERE sta.status IN ('SUCCESS','FAILED')`,
    `    AND sta.started_at < NOW() - interval '${RETENTION_DAYS} days'`,
    `)`,
  ].join(" ");

  for (const table of stgTables) {
    const deleted = await batchDelete(client, table, stgWhere);
    log.info({ table, deleted_rows: deleted }, "cleanup-staging.table.done");
    totalDeleted += deleted;
  }

  // ---- scan_result 表清理 ----
  // 先删 scan_result_usage（被 scan_result_target 外键引用）
  const scanResultWhere = [
    `scan_job_id IN (`,
    `  SELECT sj.id FROM scan_job sj`,
    `  WHERE sj.status IN ('SUCCESS','PARTIAL_SUCCESS','FAILED')`,
    `    AND sj.finished_at IS NOT NULL`,
    `    AND sj.finished_at < NOW() - interval '${RETENTION_DAYS} days'`,
    `)`,
  ].join(" ");

  const usageDeleted = await batchDelete(client, "scan_result_usage", scanResultWhere);
  log.info({ table: "scan_result_usage", deleted_rows: usageDeleted }, "cleanup-staging.table.done");
  totalDeleted += usageDeleted;

  // 再删 scan_result_target
  const targetDeleted = await batchDelete(client, "scan_result_target", scanResultWhere);
  log.info({ table: "scan_result_target", deleted_rows: targetDeleted }, "cleanup-staging.table.done");
  totalDeleted += targetDeleted;

  const duration_ms = Date.now() - start;
  log.info({ deleted_rows: totalDeleted, duration_ms }, "cleanup-staging.done");
  return { task: "cleanupStaging", deleted_rows: totalDeleted, duration_ms };
}
