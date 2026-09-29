/**
 * File: server/modules/generation/generation-progress.service.ts
 * Purpose: 生成阶段进度快照查询服务（轮询兜底通道）。
 *
 *          背景：生成进度原先只经 SSE(/api/generation/progress/:batchId) 推送。
 *          SSE 依赖长连接流式冲刷，经 Cloudflare Tunnel(cloudflared) / 反向代理时
 *          响应体会被整体缓冲，流关闭前前端收不到任何事件（写回阶段已实测复现并改为
 *          「SSE 主 + 轮询兜底」，见 app/hooks/useWritebackSSE.ts 头部说明）。
 *          生成阶段缺少该兜底，导致进度条全程停在「0 / N 已完成」，而后端计数与
 *          自动写回其实正常推进。
 *
 *          本服务从 generation_batch 读取与 SSE 完全同口径的计数
 *          （completedCount 语义 = 已处理数，含成功/跳过/失败），
 *          并从 Redis 进度键补全自动写回关联字段，供普通请求-响应式轮询使用。
 */
import prisma from "../../db/prisma.server";
import { readAutoWritebackLink } from "../../sse/progress-publisher";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "generation-progress-service" });

/** 批次已终态但写回关联字段尚未落盘时的有限重试参数（最坏 5×200ms） */
const WRITEBACK_LINK_SETTLE_ATTEMPTS = 5;
const WRITEBACK_LINK_SETTLE_DELAY_MS = 200;

/** 与 SSE 事件 status 字段同口径 */
export type GenerationProgressStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";

/** 生成进度快照（字段与 GenerationProgressEvent 对齐，前端可直接复用同一渲染逻辑） */
export interface GenerationProgressSnapshot {
  /** 批次 ID */
  batchId: string;
  /** 批次状态 */
  status: GenerationProgressStatus;
  /** 已处理条目数（含成功、跳过、失败） */
  current: number;
  /** 总条目数 */
  total: number;
  /** 跳过数 */
  skipped: number;
  /** 失败数 */
  failed: number;
  /** 自动触发的写回批次 ID（尚未触发/无需写回时为 null） */
  writebackBatchId: string | null;
  /** 自动写回未能启动时的错误码（成功时为 null） */
  writebackError: string | null;
}

/**
 * 读取生成批次进度快照。
 *
 * @param shopId  当前会话店铺 ID（用于越权防护，不匹配视为批次不存在）
 * @param batchId 生成批次 ID
 * @returns 快照；批次不存在或不属于该店铺时返回 null
 */
export async function getGenerationProgressSnapshot(
  shopId: string,
  batchId: string,
): Promise<GenerationProgressSnapshot | null> {
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      shopId: true,
      status: true,
      totalCount: true,
      completedCount: true,
      skippedCount: true,
      failedCount: true,
    },
  });

  if (!batch || batch.shopId !== shopId) {
    return null;
  }

  const status = batch.status as GenerationProgressStatus;
  const isTerminal = status !== "IN_PROGRESS";

  // 终态才需要写回关联字段；非终态读到什么都不影响进度展示，不必等待
  const autoWriteback = await readAutoWritebackLink(
    batchId,
    isTerminal
      ? {
          settleAttempts: WRITEBACK_LINK_SETTLE_ATTEMPTS,
          settleDelayMs: WRITEBACK_LINK_SETTLE_DELAY_MS,
        }
      : undefined,
  );

  if (isTerminal) {
    logger.info(
      {
        shopId,
        batchId,
        status,
        current: batch.completedCount,
        total: batch.totalCount,
        skipped: batch.skippedCount,
        failed: batch.failedCount,
        writebackBatchId: autoWriteback.writebackBatchId,
        writebackError: autoWriteback.writebackError,
      },
      "generation progress snapshot served (terminal)",
    );
  }

  return {
    batchId: batch.id,
    status,
    current: batch.completedCount,
    total: batch.totalCount,
    skipped: batch.skippedCount,
    failed: batch.failedCount,
    writebackBatchId: autoWriteback.writebackBatchId,
    writebackError: autoWriteback.writebackError,
  };
}
