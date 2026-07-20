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
  ALL_SCAN_RESOURCE_TYPES,
  type ScanPhase,
} from "../modules/scan/scan.constants";
import type { ScanResourceTotals, ScanResourceProgress } from "../modules/scan/scan.types";
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
 * 滑动窗口采样：用于 ETA 估算。
 * 仅记录最近若干次采样的时间戳与累计处理数，避免前期速率不稳影响估算。
 */
interface RateSample {
  t: number;
  processed: number;
}

const ETA_SAMPLE_MAX = 20;

/**
 * 初始化扫描进度 Redis 键。
 *
 * 在 scan_job 创建后立即调用，设置初始进度、RUNNING 状态和 started 阶段。
 * 设置 24 小时 TTL 防止孤立键。
 *
 * @param scanJobId scan_job 的主键
 */
export async function initScanProgress(
  scanJobId: string,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  // resourceTotals 各计数通过独立 hash 字段初始化为 0（由读时按需补齐，无需写入）
  await redis.hset(key, {
    totalImages: 0,
    processedImages: 0,
    failedImages: 0,
    discoveredObjects: 0,
    status: "RUNNING",
    phase: SCAN_PHASE.STARTED,
    message: "扫描已启动，正在准备提交批量查询…",
    updatedAt: new Date().toISOString(),
  });

  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, key },
    "Redis scan progress initialized",
  );
}

/**
 * 累加扫描进度中的图片总数（原料口径：媒体图数）。
 *
 * 在 Bulk 结果解析完成后，按 attempt 维度累加该 attempt 覆盖的图片总数。
 * 使用 HINCRBY 保证并发 worker 下原子累加。
 *
 * @param scanJobId scan_job 的主键
 * @param totalImages 本次解析出的图片总数（增量）
 */
export async function addScanTotalImages(
  scanJobId: string,
  totalImages: number,
): Promise<void> {
  if (totalImages <= 0) return;
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  await redis.hincrby(key, "totalImages", totalImages);
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info({ scanJobId, totalImages }, "Redis scan totalImages added");
}

/**
 * 设置发现阶段已发现对象数（Shopify Bulk objectCount 聚合值）。
 *
 * objectCount 是查询根节点已处理对象的运行计数（如商品数、文件数等），
 * 用于发现阶段的不确定进度展示「已发现 N 个对象…」。
 * 由发现阶段轮询器按 job 聚合各 attempt 的 objectCount 后整体覆盖写入，
 * 因此使用 HSET（幂等覆盖）而非 HINCRBY。
 *
 * @param scanJobId scan_job 的主键
 * @param discoveredObjects 当前已发现对象数（聚合后的绝对值）
 */
export async function setScanDiscoveredObjects(
  scanJobId: string,
  discoveredObjects: number,
): Promise<void> {
  if (discoveredObjects < 0) return;
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  // 键不存在时不创建，避免为已清理的 job 复活孤立键。
  const exists = await redis.exists(key);
  if (!exists) return;

  await redis.hset(key, {
    discoveredObjects,
    updatedAt: new Date().toISOString(),
  });
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, discoveredObjects },
    "Redis scan discoveredObjects updated",
  );
}

/**
 * 递增扫描进度中的已处理图片数（原子 HINCRBY）。
 *
 * derive 阶段每完成一个 attempt，累加该 attempt 的图片总数到 processedImages；
 * 若失败则累加到 failedImages（processedImages 不增长，failedImages 增长，
 * 二者之和即已完成处理的图片数）。
 *
 * @param scanJobId scan_job 的主键
 * @param processed 已成功处理的图片数增量
 * @param failed 失败图片数增量（可选）
 */
export async function incrementScanProcessedImages(
  scanJobId: string,
  processed: number,
  failed = 0,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  if (processed > 0) {
    await redis.hincrby(key, "processedImages", processed);
  }
  if (failed > 0) {
    await redis.hincrby(key, "failedImages", failed);
  }
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info(
    { scanJobId, processed, failed },
    "Redis scan processedImages incremented",
  );
}

/* ------------------------------------------------------------------ */
/*  按资源类型拆分的进度（用于每类独立进度条）                          */
/* ------------------------------------------------------------------ */

/**
 * Redis 进度键内 resourceTotals 的字段命名规范。
 *
 * 早期方案将每类 resourceType 的进度打包成整块 JSON 存在单个 hash 字段里，
 * 并发「读-改-写」时会发生 lost update（totalImages 与 processedImages
 * 互相覆盖）。现改为把每个计数拆成独立 hash 字段，用原子 HINCRBY 累加，
 * 各计数彼此独立、互不覆盖。
 *
 * 字段布局示例：
 *   resourceTotals:PRODUCT_MEDIA:totalImages
 *   resourceTotals:PRODUCT_MEDIA:processedImages
 *   resourceTotals:PRODUCT_MEDIA:failedImages
 *   resourceTotals:FILES:totalImages
 *   ...
 */
const RESOURCE_TOTALS_PREFIX = "resourceTotals";

/** 构造单类单指标在 Redis hash 中的字段名 */
function resourceTotalsField(
  resourceType: string,
  metric: "totalImages" | "processedImages" | "failedImages",
): string {
  return `${RESOURCE_TOTALS_PREFIX}:${resourceType}:${metric}`;
}

/** 构造全 0 的每类资源进度快照 */
function emptyResourceTotals(): ScanResourceTotals {
  const totals: ScanResourceTotals = {};
  for (const rt of ALL_SCAN_RESOURCE_TYPES) {
    totals[rt] = { resourceType: rt, totalImages: 0, processedImages: 0, failedImages: 0 };
  }
  return totals;
}

/**
 * 从 Redis hash 读取并按资源类型聚合的图片进度快照。
 *
 * 每个计数均为独立 hash 字段，HGETALL 一次性拉取后按前缀分组组装，
 * 避免串行「读-改-写」导致的 lost update。
 */
async function readResourceTotals(scanJobId: string): Promise<ScanResourceTotals> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const data = await redis.hgetall(key);
  const totals = emptyResourceTotals();

  for (const rt of ALL_SCAN_RESOURCE_TYPES) {
    const total = Number(data[resourceTotalsField(rt, "totalImages")]) || 0;
    const processed = Number(data[resourceTotalsField(rt, "processedImages")]) || 0;
    const failed = Number(data[resourceTotalsField(rt, "failedImages")]) || 0;
    totals[rt] = { resourceType: rt, totalImages: total, processedImages: processed, failedImages: failed };
  }

  return totals;
}

/**
 * 累加某资源类型的图片总数（原料口径：媒体图数）。
 *
 * 在 Bulk 结果解析完成后由 parse-bulk worker 调用，已知 resourceType，
 * 用原子 HINCRBY 追加到该类独立字段，绝不覆盖 processedImages / failedImages。
 *
 * @param scanJobId scan_job 的主键
 * @param resourceType 资源类型
 * @param totalImages 本次解析出的图片总数（增量）
 */
export async function addScanResourceTotalImages(
  scanJobId: string,
  resourceType: string,
  totalImages: number,
): Promise<void> {
  if (totalImages <= 0) return;
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const exists = await redis.exists(key);
  if (!exists) return;

  await redis.hincrby(key, resourceTotalsField(resourceType, "totalImages"), totalImages);
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info({ scanJobId, resourceType, totalImages }, "Redis scan resource totalImages added");
}

/**
 * 递增某资源类型的已处理图片数（原子 HINCRBY 独立字段）。
 *
 * derive 阶段每完成一个 attempt，累加该 attempt 的图片总数到对应类的
 * processedImages；若失败则累加到 failedImages（processedImages 不增长）。
 * 独立字段原子累加，不再读改写整块快照，规避并发 lost update。
 *
 * @param scanJobId scan_job 的主键
 * @param resourceType 资源类型
 * @param processed 已成功处理的图片数增量
 * @param failed 失败图片数增量（可选）
 */
export async function addScanResourceProcessedImages(
  scanJobId: string,
  resourceType: string,
  processed: number,
  failed = 0,
): Promise<void> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const exists = await redis.exists(key);
  if (!exists) return;

  if (processed > 0) {
    await redis.hincrby(key, resourceTotalsField(resourceType, "processedImages"), processed);
  }
  if (failed > 0) {
    await redis.hincrby(key, resourceTotalsField(resourceType, "failedImages"), failed);
  }
  await redis.expire(key, SCAN_PROGRESS_TTL_SECONDS);

  logger.info({ scanJobId, resourceType, processed, failed }, "Redis scan resource processedImages incremented");
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
  totalImages: number;
  processedImages: number;
  failedImages: number;
  discoveredObjects: number;
  resourceTotals: ScanResourceTotals;
  status: string;
  phase: string;
  message: string;
  etaSeconds: number | null;
} | null> {
  const key = getScanProgressKey(scanJobId);
  const redis = queueConnection;

  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const totalImages = Number(data.totalImages) || 0;
  const processedImages = Number(data.processedImages) || 0;
  const failedImages = Number(data.failedImages) || 0;
  const etaSeconds = await estimateEtaSeconds(
    scanJobId,
    totalImages,
    processedImages + failedImages,
  );

  return {
    totalImages,
    processedImages,
    failedImages,
    discoveredObjects: Number(data.discoveredObjects) || 0,
    resourceTotals: await readResourceTotals(scanJobId),
    status: data.status ?? "UNKNOWN",
    phase: data.phase ?? "started",
    message: data.message ?? "",
    etaSeconds,
  };
}

/**
 * 速率采样 Redis 列表键（保留最近若干次 (timestamp, processed) 样本）。
 */
function getRateSampleKey(scanJobId: string): string {
  return `${SCAN_PROGRESS_KEY_PREFIX}:${scanJobId}:rate`;
}

/**
 * 记录一次速率采样并基于滑动窗口估算 ETA。
 *
 * 仅在处理阶段（totalImages > 0）才采样；用最近若干次样本的
 * (处理增量 / 时间增量) 求平均速率，推算剩余图片所需秒数。
 *
 * @returns 预计剩余秒数；样本不足或已无剩余时返回 null
 */
async function estimateEtaSeconds(
  scanJobId: string,
  totalImages: number,
  doneImages: number,
): Promise<number | null> {
  if (totalImages <= 0) return null;
  const remaining = totalImages - doneImages;
  if (remaining <= 0) return 0;

  const redis = queueConnection;
  const sampleKey = getRateSampleKey(scanJobId);
  const now = Date.now();

  try {
    const sample: RateSample = { t: now, processed: doneImages };
    await redis.rpush(sampleKey, JSON.stringify(sample));
    await redis.ltrim(sampleKey, -ETA_SAMPLE_MAX, -1);
    await redis.expire(sampleKey, SCAN_PROGRESS_TTL_SECONDS);

    const raw = await redis.lrange(sampleKey, 0, -1);
    if (raw.length < 2) return null;

    const samples: RateSample[] = raw
      .map((s) => {
        try {
          return JSON.parse(s) as RateSample;
        } catch {
          return null;
        }
      })
      .filter((s): s is RateSample => s !== null)
      .sort((a, b) => a.t - b.t);

    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const dtMs = newest.t - oldest.t;
    const dProcessed = newest.processed - oldest.processed;

    if (dtMs <= 0 || dProcessed <= 0) return null;

    const ratePerMs = dProcessed / dtMs;
    return Math.round(remaining / ratePerMs / 1000);
  } catch (error) {
    logger.warn({ scanJobId, err: error }, "scan ETA estimate failed");
    return null;
  }
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
