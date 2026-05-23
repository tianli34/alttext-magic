/**
 * File: worker/jobs/gdpr/gdprDelete.ts
 * Purpose: GDPR 数据清理 Job —— 按 FK 依赖拓扑顺序分批删除指定店铺的全部数据。
 *
 * ### 删除策略
 * 1. **幂等校验**：先检查 shop 是否存在，不存在则跳过（`skipped: already_deleted`）。
 * 2. **拓扑顺序**：从最深子表 → 主表逐表删除，避免 FK 约束冲突。
 * 3. **分批删除**：每张表循环 `DELETE WHERE pk IN (SELECT pk FROM ... LIMIT 1000)`，
 *    单次不足 1000 行时跳出，防止长事务与锁死。
 * 4. **结构化日志**：每张表完成后记录 `table`、`deleted_rows`、`duration_ms`。
 *
 * ### 表删除顺序（参见 docs/phase9-delete-order.md）
 * audit_log → job_item → alt_draft → decorative_mark → candidate_group_projection →
 * alt_candidate → image_usage → alt_target → scan_result_usage → scan_result_target →
 * stg_product → stg_media_image_product → stg_media_image_file → stg_collection →
 * stg_article → scan_task_attempt → scan_task → scan_job → credit_ledger →
 * credit_reservation_line → credit_reservation → credit_bucket → billing_ledger →
 * overage_pack_purchase → billing_subscription → webhook_events → job_batch →
 * generation_batch → ai_model_call → resource_image_fingerprint → shop_operation_lock →
 * scan_notice_ack → Session → shops
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";
import type { GdprDeleteJobData } from "../../../server/queues/gdpr-delete.queue.js";

const log = createLogger({ module: "gdpr-delete-job" });

/** 每批删除行数上限 */
const BATCH_SIZE = 1000;

/** 单张表的删除结果 */
interface TableDeleteResult {
  /** 表名 */
  table: string;
  /** 总删除行数 */
  deleted_rows: number;
  /** 耗时（毫秒） */
  duration_ms: number;
}

/** 整体 GDPR 删除结果 */
export interface GdprDeleteResult {
  /** 店铺 ID */
  shopId: string;
  /** 触发原因 */
  reason: string;
  /** 是否跳过（店铺已删除） */
  skipped: boolean;
  /** 总耗时（毫秒） */
  total_duration_ms: number;
  /** 各表删除结果 */
  tables: TableDeleteResult[];
}

/**
 * 删除配置项。
 *
 * - `shopId`：按 `WHERE <column> = <shopId>` 分批删除，pkColumn 默认 "id"
 * - `shopDomain`：按 `WHERE <column> = <shopDomain>` 分批删除
 * - `subquery`：按自定义 WHERE 条件分批删除
 * - `primaryKey`：直接按主键值删除（shops 表），pkColumn 为 "id"
 * - `direct`：直接按 WHERE 条件删除不分批（适用于 1:1 关系表如 shop_operation_lock）
 */
type DeleteConfig =
  | { table: string; column: string; type: "shopId"; pkColumn?: string }
  | { table: string; column: string; type: "shopDomain"; pkColumn?: string }
  | { table: string; where: string; type: "subquery"; pkColumn?: string }
  | { table: string; column: string; value: string; type: "primaryKey"; pkColumn?: string }
  | { table: string; where: string; type: "direct" };

/**
 * 按拓扑顺序定义 34 张表的删除配置。
 * 顺序严格遵循 docs/phase9-delete-order.md 中的依赖图。
 *
 * 注意：`shopId` 和 `shopDomain` 是服务端内部可信值（CUID / Shopify domain），
 * 且表名/列名为硬编码常量，不存在 SQL 注入风险。
 */
function buildDeleteConfigs(shopId: string, shopDomain: string): DeleteConfig[] {
  return [
    // 1. audit_log — 审计日志（最深子表，许多 FK 引用）
    { table: "audit_log", column: "shop_id", type: "shopId" },

    // 2. job_item — 作业明细（无直接 shop_id，通过 job_batch 子查询）
    {
      table: "job_item",
      type: "subquery",
      where: `"batch_id" IN (SELECT "id" FROM "job_batch" WHERE "shop_id" = '${shopId}')`,
    },

    // 3. alt_draft — 生成草稿
    { table: "alt_draft", column: "shop_id", type: "shopId" },

    // 4. decorative_mark — 装饰标记
    { table: "decorative_mark", column: "shop_id", type: "shopId" },

    // 5. candidate_group_projection — 分组投影
    { table: "candidate_group_projection", column: "shop_id", type: "shopId" },

    // 6. alt_candidate — 候选 Alt
    { table: "alt_candidate", column: "shop_id", type: "shopId" },

    // 7. image_usage — 图片使用
    { table: "image_usage", column: "shop_id", type: "shopId" },

    // 8. alt_target — Alt 目标
    { table: "alt_target", column: "shop_id", type: "shopId" },

    // 9. scan_result_usage — 扫描结果使用
    { table: "scan_result_usage", column: "shop_id", type: "shopId" },

    // 10. scan_result_target — 扫描结果目标
    { table: "scan_result_target", column: "shop_id", type: "shopId" },

    // 11. stg_product — 暂存产品
    { table: "stg_product", column: "shop_id", type: "shopId" },

    // 12. stg_media_image_product — 暂存媒体图片
    { table: "stg_media_image_product", column: "shop_id", type: "shopId" },

    // 13. stg_media_image_file — 暂存媒体文件
    { table: "stg_media_image_file", column: "shop_id", type: "shopId" },

    // 14. stg_collection — 暂存集合
    { table: "stg_collection", column: "shop_id", type: "shopId" },

    // 15. stg_article — 暂存文章
    { table: "stg_article", column: "shop_id", type: "shopId" },

    // 16. scan_task_attempt — 扫描任务尝试
    { table: "scan_task_attempt", column: "shop_id", type: "shopId" },

    // 17. scan_task — 扫描任务
    { table: "scan_task", column: "shop_id", type: "shopId" },

    // 18. scan_job — 扫描作业
    { table: "scan_job", column: "shop_id", type: "shopId" },

    // 19. credit_ledger — 额度流水
    { table: "credit_ledger", column: "shop_id", type: "shopId" },

    // 20. credit_reservation_line — 保留明细
    { table: "credit_reservation_line", column: "shop_id", type: "shopId" },

    // 21. credit_reservation — 额度保留
    { table: "credit_reservation", column: "shop_id", type: "shopId" },

    // 22. credit_bucket — 额度桶
    { table: "credit_bucket", column: "shop_id", type: "shopId" },

    // 23. billing_ledger — 账单流水
    { table: "billing_ledger", column: "shop_id", type: "shopId" },

    // 24. overage_pack_purchase — 超额包购买
    { table: "overage_pack_purchase", column: "shop_id", type: "shopId" },

    // 25. billing_subscription — 账单订阅
    { table: "billing_subscription", column: "shop_id", type: "shopId" },

    // 26. webhook_events — 使用 shop_domain 过滤
    { table: "webhook_events", column: "shop_domain", type: "shopDomain" },

    // 27. job_batch — 作业批次
    { table: "job_batch", column: "shop_id", type: "shopId" },

    // 28. generation_batch — 生成批次
    { table: "generation_batch", column: "shop_id", type: "shopId" },

    // 29. ai_model_call — AI 模型调用
    { table: "ai_model_call", column: "shop_id", type: "shopId" },

    // 30. resource_image_fingerprint — 图片指纹
    { table: "resource_image_fingerprint", column: "shop_id", type: "shopId" },

    // 31. shop_operation_lock — 操作锁（shop_id 即主键，1:1 关系，直接删除不分批）
    {
      table: "shop_operation_lock",
      type: "direct",
      where: `"shop_id" = '${shopId}'`,
    },

    // 32. scan_notice_ack — 通知确认
    { table: "scan_notice_ack", column: "shop_id", type: "shopId" },

    // 33. Session — 会话表（使用 shop 字段匹配 shopDomain）
    { table: '"Session"', column: "shop", type: "shopDomain" },

    // 34. shops — 主表店铺记录（按主键 id 删除）
    { table: "shops", column: "id", value: shopId, type: "primaryKey" },
  ];
}

/**
 * 对单张表执行分批循环删除。
 *
 * PostgreSQL 原生 DELETE 不支持 LIMIT，采用：
 * ```sql
 * DELETE FROM "table" WHERE "pk" IN (SELECT "pk" FROM "table" WHERE <condition> LIMIT 1000)
 * ```
 *
 * @param db PrismaClient 实例
 * @param config 删除配置
 * @param shopId 店铺 ID
 * @param shopDomain 店铺域名
 */
async function batchDeleteTable(
  db: PrismaClient,
  config: DeleteConfig,
  shopId: string,
  shopDomain: string,
): Promise<TableDeleteResult> {
  const start = Date.now();
  let totalDeleted = 0;

  // 构建 WHERE 条件
  let whereClause: string;
  switch (config.type) {
    case "shopId":
      whereClause = `"${config.column}" = '${shopId}'`;
      break;
    case "shopDomain":
      whereClause = `"${config.column}" = '${shopDomain}'`;
      break;
    case "subquery":
      whereClause = config.where;
      break;
    case "primaryKey":
      whereClause = `"${config.column}" = '${config.value}'`;
      break;
    case "direct":
      whereClause = config.where;
      break;
  }

  // direct 类型：直接删除（不分批），适用于 1:1 关系表
  if (config.type === "direct") {
    const sql = `DELETE FROM ${config.table} WHERE ${whereClause}`;
    totalDeleted = await db.$executeRawUnsafe(sql);
    const duration_ms = Date.now() - start;
    return { table: config.table.replace(/"/g, ""), deleted_rows: totalDeleted, duration_ms };
  }

  // 分批删除：主键列名（默认 "id"，可覆盖）
  const pk = config.pkColumn ?? "id";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sql = `DELETE FROM ${config.table} WHERE "${pk}" IN (SELECT "${pk}" FROM ${config.table} WHERE ${whereClause} LIMIT ${BATCH_SIZE})`;
    const result = await db.$executeRawUnsafe(sql);
    totalDeleted += result;
    if (result < BATCH_SIZE) break;
  }

  const duration_ms = Date.now() - start;
  return { table: config.table.replace(/"/g, ""), deleted_rows: totalDeleted, duration_ms };
}

/**
 * GDPR 数据清理 Job 主入口。
 *
 * @param data Job 入参（shopId, shopDomain, reason, source）
 * @param client 可选 PrismaClient 实例（测试时注入）
 * @returns 删除结果
 */
export async function runGdprDeleteJob(
  data: GdprDeleteJobData,
  client?: PrismaClient,
): Promise<GdprDeleteResult> {
  const { shopId, shopDomain, reason } = data;
  const overallStart = Date.now();

  // 懒加载全局 Prisma 单例
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import("../../../server/db/prisma.server.js")).default;

  // --- 幂等校验：若 shop 已不存在则直接返回 ---
  const shopExists = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT 1 as id FROM "shops" WHERE "id" = '${shopId}'`,
  );
  if (shopExists.length === 0) {
    const duration_ms = Date.now() - overallStart;
    log.info(
      { shopId, shopDomain, reason, duration_ms },
      "gdpr-delete.skipped:already_deleted",
    );
    return {
      shopId,
      reason,
      skipped: true,
      total_duration_ms: duration_ms,
      tables: [],
    };
  }

  log.info({ shopId, shopDomain, reason }, "gdpr-delete.start");

  // 构建删除配置列表
  const configs = buildDeleteConfigs(shopId, shopDomain);
  const results: TableDeleteResult[] = [];

  // 逐表串行删除
  for (const config of configs) {
    try {
      const result = await batchDeleteTable(db, config, shopId, shopDomain);
      results.push(result);
      log.info(
        {
          shopId,
          table: result.table,
          deleted_rows: result.deleted_rows,
          duration_ms: result.duration_ms,
        },
        "gdpr-delete.table.done",
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(
        { shopId, table: config.table, err: errMsg },
        "gdpr-delete.table.failed",
      );
      // 记录失败但继续执行后续表，确保尽可能多的数据被清理
      results.push({
        table: config.table.replace(/"/g, ""),
        deleted_rows: 0,
        duration_ms: 0,
      });
    }
  }

  const total_duration_ms = Date.now() - overallStart;
  const totalDeletedRows = results.reduce((sum, r) => sum + r.deleted_rows, 0);

  log.info(
    {
      shopId,
      shopDomain,
      reason,
      total_deleted_rows: totalDeletedRows,
      total_duration_ms,
      tables: results.length,
    },
    "gdpr-delete.complete",
  );

  return {
    shopId,
    reason,
    skipped: false,
    total_duration_ms,
    tables: results,
  };
}
