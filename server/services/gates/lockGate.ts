/**
 * File: server/services/gates/lockGate.ts
 * Purpose: Gate 1 — 互斥锁门控。
 *          在 product / collection job 开始时检查是否有 SCAN RUNNING 锁，
 *          有锁则延迟重试，超限则标记 webhook_event FAILED。
 *
 * 使用方式（在 worker processor 中）：
 * ```ts
 * const result = await delayJobForLock(job);
 * if (result.delayed || result.exceeded) return; // 已由 gate 处理
 * // 正常业务处理 ...
 * ```
 */

import type { Job } from "bullmq";
import { isOperationRunning } from "../../modules/lock/operation-lock.service";
import { markFailed } from "../../modules/scan/continuous/webhook-event.service";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "lock-gate" });

/** 默认延迟 30 秒 */
export const DEFAULT_LOCK_GATE_DELAY_MS = 30_000;

/** 默认最大重试次数 */
export const DEFAULT_LOCK_GATE_MAX_RETRIES = 20;

/** lockGate 要求 job data 至少包含的字段 */
export interface LockGateJobData {
  shopId: string;
  latestWebhookEventId: string;
  /** 内部字段：扫描锁重试计数，由 gate 自动维护 */
  _scanLockRetryCount?: number;
}

/** delayJobForLock 返回结果 */
export interface DelayJobForLockResult {
  /** job 已被延迟，等待下次重试 */
  delayed: boolean;
  /** 已超过最大重试次数，webhook_event 已标记为 FAILED */
  exceeded: boolean;
}

/* ------------------------------------------------------------------ */
/*  可注入依赖（方便测试）                                              */
/* ------------------------------------------------------------------ */

/** 检查扫描锁的函数签名 */
export type CheckScanLockFn = (shopId: string) => Promise<boolean>;

/** 标记 webhook_event FAILED 的函数签名 */
export type MarkWebhookEventFailedFn = (webhookEventId: string) => Promise<void>;

/** 当前注入的 checkScanLock 实现 */
let _checkScanLock: CheckScanLockFn = (shopId) =>
  isOperationRunning(shopId, "SCAN");

/** 当前注入的 markFailed 实现 */
let _markWebhookEventFailed: MarkWebhookEventFailedFn = (id) =>
  markFailed(id, new Error("lock-gate.retry-exceeded"));

/**
 * 注入自定义 checkScanLock 实现（测试用）。
 */
export function setCheckScanLockFn(fn: CheckScanLockFn): void {
  _checkScanLock = fn;
}

/**
 * 注入自定义 markWebhookEventFailed 实现（测试用）。
 */
export function setMarkWebhookEventFailedFn(fn: MarkWebhookEventFailedFn): void {
  _markWebhookEventFailed = fn;
}

/**
 * 重置为默认实现。
 */
export function resetLockGateDeps(): void {
  _checkScanLock = (shopId) => isOperationRunning(shopId, "SCAN");
  _markWebhookEventFailed = (id) =>
    markFailed(id, new Error("lock-gate.retry-exceeded"));
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 查询当前 shop 是否存在状态为 RUNNING 的全量扫描锁。
 *
 * @param shopId 店铺 ID
 * @returns true=存在 RUNNING 扫描锁（阻塞），false=无锁（放行）
 */
export async function checkScanLock(shopId: string): Promise<boolean> {
  return _checkScanLock(shopId);
}

/**
 * 在 product / collection job 开始时执行互斥锁门控：
 * - 无锁：放行（返回 delayed=false, exceeded=false）
 * - 有锁 + 未超限：使用 `job.moveToDelayed` 延迟重试
 * - 有锁 + 已超限：标记 webhook_event FAILED（返回 exceeded=true）
 *
 * @param job    BullMQ Job 实例（data 需包含 shopId + latestWebhookEventId）
 * @param delayMs     延迟毫秒数，默认 30000
 * @param maxRetries  最大重试次数，默认 20
 * @returns 结果对象
 */
export async function delayJobForLock(
  job: Job<LockGateJobData>,
  delayMs: number = DEFAULT_LOCK_GATE_DELAY_MS,
  maxRetries: number = DEFAULT_LOCK_GATE_MAX_RETRIES,
): Promise<DelayJobForLockResult> {
  const { shopId, latestWebhookEventId } = job.data;

  // 1. 检查扫描锁
  const hasLock = await checkScanLock(shopId);

  if (!hasLock) {
    // 无锁，放行
    return { delayed: false, exceeded: false };
  }

  // 2. 有锁，检查重试次数
  const retryCount = job.data._scanLockRetryCount ?? 0;

  if (retryCount >= maxRetries) {
    // 超限，标记 webhook_event FAILED
    logger.warn(
      { shopId, latestWebhookEventId, retryCount, maxRetries },
      "lock-gate.retry-exceeded",
    );

    await _markWebhookEventFailed(latestWebhookEventId);

    return { delayed: false, exceeded: true };
  }

  // 3. 未超限，延迟重试
  const nextRetryCount = retryCount + 1;
  await job.updateData({
    ...job.data,
    _scanLockRetryCount: nextRetryCount,
  });

  const delayUntil = Date.now() + delayMs;
  await job.moveToDelayed(delayUntil, job.token ?? undefined);

  logger.info(
    {
      shopId,
      retryCount: nextRetryCount,
      maxRetries,
      delayMs,
      jobId: job.id,
    },
    "lock-gate.job-delayed",
  );

  return { delayed: true, exceeded: false };
}
