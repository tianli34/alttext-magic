/**
 * File: worker/jobs/cleanup/cleanupWebhookEvent.ts
 * Purpose: 清理已处理超过 7 天的 WebhookEvent 记录。
 *          删除 processed_at IS NOT NULL AND created_at < NOW() - interval '7 days' 的记录，
 *          采用 LIMIT 1000 循环避免长事务。
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";

const log = createLogger({ module: "cleanup-webhook-event" });

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
 * 批量删除已处理超过 7 天的 WebhookEvent 记录。
 *
 * ### SQL 策略
 * ```sql
 * DELETE FROM webhook_events WHERE id IN (
 *   SELECT id FROM webhook_events
 *   WHERE processed_at IS NOT NULL
 *     AND created_at < NOW() - interval '7 days'
 *   LIMIT 1000
 * )
 * ```
 * - 依赖 `webhook_events_processed_at_idx` 和 `webhook_events_created_at_idx` 索引。
 * - 仅删除已处理完毕（processed_at IS NOT NULL）的事件，保留未处理的。
 *
 * @param client PrismaClient 实例
 * @returns 删除行数与耗时
 */
export async function cleanupWebhookEvent(client: PrismaClient): Promise<CleanupResult> {
  const start = Date.now();
  let totalDeleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await client.$executeRaw`
      DELETE FROM webhook_events WHERE id IN (
        SELECT id FROM webhook_events
        WHERE processed_at IS NOT NULL
          AND created_at < NOW() - interval '${RETENTION_DAYS} days'
        LIMIT ${BATCH_SIZE}
      )
    `;
    totalDeleted += result;
    if (result < BATCH_SIZE) break;
  }

  const duration_ms = Date.now() - start;
  log.info({ deleted_rows: totalDeleted, duration_ms }, "cleanup-webhook-event.done");
  return { task: "cleanupWebhookEvent", deleted_rows: totalDeleted, duration_ms };
}
