/**
 * File: server/sse/progress-publisher.ts
 * Purpose: 扫描进度 Redis 发布器。
 *          负责初始化 Redis 进度键、更新进度、读取进度。
 *          供 SSE 端点和扫描 worker 共同使用。
 */
import { queueConnection } from "../queues/connection";
import {
  SCAN_PROGRESS_KEY_PREFIX,
  SCAN_PROGRESS_TTL_SECONDS,
} from "../modules/scan/scan.constants";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "progress-publisher" });

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
 * 在 scan_job 创建后立即调用，设置初始进度（0/totalTasks）和 RUNNING 状态。
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
  });

  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, totalTasks, key },
    "Redis scan progress initialized",
  );
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
 */
export async function setScanProgressStatus(
  scanJobId: string,
  status: string,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  await redis.hset(key, { status });

  logger.info({ scanJobId, status }, "Redis scan progress status updated");
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
  };
}
