/**
 * File: server/sse/progress-publisher.ts
 * Purpose: 扫描进度 + 生成进度 Redis 发布器。
 *          负责初始化 Redis 进度键、更新进度、读取进度。
 *          生成进度额外通过 Redis Pub/Sub 推送实时事件。
 *          供 SSE 端点、扫描 worker 和生成 worker 共同使用。
 */
import { queueConnection } from "../queues/connection";
import {
  SCAN_PROGRESS_KEY_PREFIX,
  SCAN_PROGRESS_TTL_SECONDS,
  SCAN_PHASE,
  type ScanPhase,
} from "../modules/scan/scan.constants";
import { createLogger } from "../utils/logger";
import prisma from "../db/prisma.server";

const logger = createLogger({ module: "progress-publisher" });
const GENERATION_PROGRESS_KEY_PREFIX = "generation:progress";
const GENERATION_PROGRESS_CHANNEL_PREFIX = "generation:progress:events";
const GENERATION_PROGRESS_TTL_SECONDS = 24 * 60 * 60;

/**
 * 生成进度 SSE 事件格式。
 * 对应任务 6.10 的 event payload 规范。
 */
export interface GenerationProgressEvent {
  /** 事件类型 */
  type: "generation_progress" | "generation_completed";
  /** 批次 ID */
  batchId: string;
  /** 已处理条目数（含成功、跳过、失败） */
  current: number;
  /** 总条目数 */
  total: number;
  /** 跳过数 */
  skipped: number;
  /** 失败数 */
  failed: number;
  /** 批次状态 */
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

/**
 * 构造扫描进度的 Redis 键。
 * @param scanJobId scan_job 的主键
 */
export function getScanProgressKey(scanJobId: string): string {
  return `${SCAN_PROGRESS_KEY_PREFIX}:${scanJobId}`;
}

/**
 * 初始化扫描进度 Redis 键。
 *
 * 在 scan_job 创建后立即调用，设置初始进度（0/totalTasks）、RUNNING 状态和 started 阶段。
 * 设置 24 小时 TTL 防止孤立键。
 *
 * @param scanJobId scan_job 的主键
 * @param totalTasks scan_task 总数（已启用的资源类型数量）
 */
export async function initScanProgress(
  scanJobId: string,
  totalTasks: number,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  await redis.hset(key, {
    completedTasks: 0,
    totalTasks,
    status: "RUNNING",
    phase: SCAN_PHASE.STARTED,
    message: "扫描已启动，正在准备提交批量查询…",
    updatedAt: new Date().toISOString(),
  });

  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, totalTasks, key },
    "Redis scan progress initialized",
  );
}

/**
 * 更新扫描进度阶段和消息。
 *
 * @param scanJobId scan_job 的主键
 * @param phase 当前阶段
 * @param message 阶段描述消息（可选）
 */
export async function updateScanProgressPhase(
  scanJobId: string,
  phase: ScanPhase,
  message?: string,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const update: Record<string, string> = {
    phase,
    updatedAt: new Date().toISOString(),
  };
  if (message) {
    update.message = message;
  }

  await redis.hset(key, update);
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info({ scanJobId, phase, message }, "Redis scan progress phase updated");
}

/**
 * 更新扫描进度：递增已完成任务数。
 *
 * @param scanJobId scan_job 的主键
 * @returns 更新后的 completedTasks 值
 */
export async function incrementScanProgress(
  scanJobId: string,
): Promise<number> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const completedTasks = await redis.hincrby(key, "completedTasks", 1);
  await redis.hset(key, { updatedAt: new Date().toISOString() });
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, completedTasks },
    "Redis scan progress incremented",
  );

  return completedTasks;
}

/**
 * 更新扫描进度：标记为最终状态（SUCCESS / PARTIAL_SUCCESS / FAILED）。
 *
 * @param scanJobId scan_job 的主键
 * @param status 最终状态
 * @param phase 最终阶段（默认根据 status 自动推导）
 */
export async function setScanProgressStatus(
  scanJobId: string,
  status: string,
  phase?: ScanPhase,
  messageOverride?: string,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const resolvedPhase =
    phase ??
    (status === "FAILED" ? SCAN_PHASE.FAILED : SCAN_PHASE.DONE);

  const message =
    messageOverride ??
    (status === "FAILED"
      ? "扫描失败，请检查或重试"
      : status === "PARTIAL_SUCCESS"
        ? "扫描部分完成，正在发布结果…"
        : "扫描完成");

  await redis.hset(key, {
    status,
    phase: resolvedPhase,
    message,
    updatedAt: new Date().toISOString(),
  });
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info({ scanJobId, status, phase: resolvedPhase }, "Redis scan progress status updated");
}

/**
 * 读取扫描进度。
 *
 * @param scanJobId scan_job 的主键
 * @returns 进度数据，若键不存在返回 null
 */
export async function getScanProgress(scanJobId: string): Promise<{
  completedTasks: number;
  totalTasks: number;
  status: string;
  phase: string;
  message: string;
} | null> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    completedTasks: Number(data.completedTasks) || 0,
    totalTasks: Number(data.totalTasks) || 0,
    status: data.status ?? "UNKNOWN",
    phase: data.phase ?? "started",
    message: data.message ?? "",
  };
}

/**
 * 删除扫描进度键。
 *
 * 用于后台兜底清理已终止但 Redis 仍残留的 RUNNING 进度。
 *
 * @param scanJobId scan_job 的主键
 * @returns 删除的键数量
 */
export async function deleteScanProgress(scanJobId: string): Promise<number> {
  const key = getScanProgressKey(scanJobId);
  const deletedCount = await queueConnection.del(key);

  logger.info({ scanJobId, key, deletedCount }, "Redis scan progress deleted");

  return deletedCount;
}

export function getGenerationProgressKey(batchId: string): string {
  return `${GENERATION_PROGRESS_KEY_PREFIX}:${batchId}`;
}

/**
 * 构造生成进度 Redis Pub/Sub 频道名。
 * @param batchId 批次 ID
 */
export function getGenerationProgressChannel(batchId: string): string {
  return `${GENERATION_PROGRESS_CHANNEL_PREFIX}:${batchId}`;
}

export async function initGenerationProgress(
  batchId: string,
  totalItems: number,
): Promise<void> {
  const key = getGenerationProgressKey(batchId);

  await queueConnection.hset(key, {
    completedTasks: 0,
    totalTasks: totalItems,
    status: "RUNNING",
    phase: "generating",
    message: "AI 生成已启动",
    updatedAt: new Date().toISOString(),
  });
  await queueConnection.expire(key, GENERATION_PROGRESS_TTL_SECONDS);

  logger.info({ batchId, totalItems, key }, "Redis generation progress initialized");
}

/**
 * 从 Redis hash 读取当前生成进度快照。
 * 用于 SSE 连接初始化时恢复已丢失的事件。
 */
export async function readGenerationProgress(batchId: string): Promise<{
  completedTasks: number;
  totalTasks: number;
  skippedTasks: number;
  failedTasks: number;
  status: string;
  phase: string;
  message: string;
} | null> {
  const key = getGenerationProgressKey(batchId);
  const data = await queueConnection.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    completedTasks: Number(data.completedTasks) || 0,
    totalTasks: Number(data.totalTasks) || 0,
    skippedTasks: Number(data.skippedTasks) || 0,
    failedTasks: Number(data.failedTasks) || 0,
    status: data.status ?? "UNKNOWN",
    phase: data.phase ?? "generating",
    message: data.message ?? "",
  };
}

/**
 * 发布生成进度到 Redis hash + Pub/Sub 频道。
 *
 * 在 generate-alt worker 的 finally 中调用。
 * 每条 job 完成后写 Redis hash 并通过 Pub/Sub 推送实时事件；
 * 当 batch 进入终态时额外发送 generation_completed 汇总事件。
 */
export async function publishGenerationProgress(batchId: string): Promise<void> {
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: {
      totalCount: true,
      completedCount: true,
      skippedCount: true,
      failedCount: true,
      status: true,
    },
  });

  if (!batch) {
    logger.warn({ batchId }, "generation progress skipped: batch not found");
    return;
  }

  const isTerminal = batch.status !== "IN_PROGRESS";
  const phase = isTerminal ? "done" : "generating";
  const message = isTerminal
    ? batch.failedCount > 0
      ? "AI 生成完成，存在失败项"
      : "AI 生成完成"
    : "AI 生成进行中";

  // 1. 写 Redis hash（保持与扫描进度一致的模式）
  await queueConnection.hset(getGenerationProgressKey(batchId), {
    completedTasks: batch.completedCount,
    totalTasks: batch.totalCount,
    skippedTasks: batch.skippedCount,
    failedTasks: batch.failedCount,
    status: batch.status,
    phase,
    message,
    updatedAt: new Date().toISOString(),
  });
  await queueConnection.expire(
    getGenerationProgressKey(batchId),
    GENERATION_PROGRESS_TTL_SECONDS,
  );

  // 2. 通过 Pub/Sub 推送实时进度事件
  const channel = getGenerationProgressChannel(batchId);

  const progressEvent: GenerationProgressEvent = {
    type: "generation_progress",
    batchId,
    current: batch.completedCount,
    total: batch.totalCount,
    skipped: batch.skippedCount,
    failed: batch.failedCount,
    status: batch.status as GenerationProgressEvent["status"],
  };
  await queueConnection.publish(channel, JSON.stringify(progressEvent));

  // 3. 终态时额外发送汇总事件
  if (isTerminal) {
    const completedEvent: GenerationProgressEvent = {
      type: "generation_completed",
      batchId,
      current: batch.completedCount,
      total: batch.totalCount,
      skipped: batch.skippedCount,
      failed: batch.failedCount,
      status: batch.status as GenerationProgressEvent["status"],
    };
    await queueConnection.publish(channel, JSON.stringify(completedEvent));
  }

  logger.info(
    {
      batchId,
      completedCount: batch.completedCount,
      totalCount: batch.totalCount,
      status: batch.status,
      isTerminal,
    },
    "Generation progress published via Pub/Sub",
  );
}
