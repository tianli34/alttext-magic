/**
 * File: worker/jobs/cleanup/cleanupJob.ts
 * Purpose: Cleanup 主 handler —— 串行调用 5 个子任务，汇总记录每个子任务的 deleted_rows 与 duration_ms。
 *
 * ### 子任务列表
 * 1. cleanupAltDraft     — 清理过期 AltDraft
 * 2. cleanupAuditLog     — 清理 90 天前的审计日志
 * 3. cleanupStaging      — 清理 staging 表与 scan_result 表（7 天）
 * 4. cleanupFailedAttempt — 清理失败 attempt（7 天）
 * 5. cleanupWebhookEvent — 清理已处理的 webhook 事件（7 天）
 */

import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../../server/utils/logger.js";
import { cleanupAltDraft } from "./cleanupAltDraft.js";
import { cleanupAuditLog } from "./cleanupAuditLog.js";
import { cleanupStaging } from "./cleanupStaging.js";
import { cleanupFailedAttempt } from "./cleanupFailedAttempt.js";
import { cleanupWebhookEvent } from "./cleanupWebhookEvent.js";

const log = createLogger({ module: "cleanup-job" });

/** 单个子任务的执行结果 */
export interface SubTaskResult {
  /** 子任务名称 */
  task: string;
  /** 总删除行数 */
  deleted_rows: number;
  /** 执行耗时（毫秒） */
  duration_ms: number;
}

/** 整体 Cleanup Job 的执行结果 */
export interface CleanupJobResult {
  /** 触发来源 */
  source: string;
  /** 总耗时（毫秒） */
  total_duration_ms: number;
  /** 各子任务结果 */
  subtasks: SubTaskResult[];
}

/**
 * 串行执行所有 Cleanup 子任务。
 *
 * ### 设计决策
 * - **串行执行**：避免并发删除导致的锁争用与死锁风险。
 * - **单子任务失败不中断**：catch 错误后记录，继续执行后续子任务。
 * - **每子任务记录指标**：deleted_rows + duration_ms 用于可观测性。
 *
 * @param client PrismaClient 实例（可选，默认使用全局单例）
 * @param source 触发来源（scheduled / manual）
 * @returns 整体执行结果
 */
export async function runCleanupJob(
  client?: PrismaClient,
  source = "scheduled",
): Promise<CleanupJobResult> {
  const start = Date.now();
  // 懒加载全局 Prisma 单例
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import("../../../server/db/prisma.server.js")).default;

  const subtasks: SubTaskResult[] = [];

  // 定义子任务执行列表（串行）
  const taskList: Array<{ name: string; fn: (c: PrismaClient) => Promise<SubTaskResult> }> = [
    { name: "cleanupAltDraft", fn: cleanupAltDraft },
    { name: "cleanupAuditLog", fn: cleanupAuditLog },
    { name: "cleanupStaging", fn: cleanupStaging },
    { name: "cleanupFailedAttempt", fn: cleanupFailedAttempt },
    { name: "cleanupWebhookEvent", fn: cleanupWebhookEvent },
  ];

  for (const { name, fn } of taskList) {
    try {
      log.info({ task: name }, "cleanup.subtask.start");
      const result = await fn(db);
      subtasks.push(result);
      log.info(
        { task: name, deleted_rows: result.deleted_rows, duration_ms: result.duration_ms },
        "cleanup.subtask.done",
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : String(error);
      log.error({ task: name, err }, "cleanup.subtask.failed");
      subtasks.push({
        task: name,
        deleted_rows: 0,
        duration_ms: 0,
      });
    }
  }

  const total_duration_ms = Date.now() - start;
  const result: CleanupJobResult = {
    source,
    total_duration_ms,
    subtasks,
  };

  log.info(
    {
      source,
      total_duration_ms,
      subtasks: subtasks.map((s) => `${s.task}:${s.deleted_rows}rows/${s.duration_ms}ms`),
    },
    "cleanup-job.completed",
  );

  return result;
}
