/**
 * File: server/modules/generation/generation-batch.service.ts
 * Purpose: 管理 AI 生成 batch 的创建、进度结算、完成收尾与超时兜底。
 */
import { AltCandidateStatus, GenerationBatchStatus, Prisma, type GenerationBatch, type PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { releaseGenerateLock } from "../lock/generate-lock.service";
import { createLogger } from "../../utils/logger";
import { GenerationCreditService } from "./generation-credit.service";
import { queueConnection } from "../../queues/connection";
import { getGenerationProgressKey } from "../../sse/progress-publisher";
import {
  startWriteback,
  WritebackStartError,
} from "../writeback/writeback.service";

const logger = createLogger({ module: "generation-batch-service" });

type TransactionClient = Prisma.TransactionClient;
type BatchProgressCounter = "completed" | "skipped" | "failed";

interface CreateBatchResult {
  batch: GenerationBatch;
}

interface MarkJobFinishedParams {
  shopId: string;
  batchId: string;
  result: BatchProgressCounter;
}

interface FinalizeTimedOutBatchesParams {
  olderThanMinutes: number;
  now?: Date;
}

interface LockedBatchRow {
  id: string;
  shop_id: string;
  status: GenerationBatchStatus;
  total_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
}

interface BatchFinalizeCandidate {
  shopId: string;
  batchId: string;
  status: GenerationBatchStatus;
  completedCount: number;
  totalCount: number;
  skippedCount: number;
  failedCount: number;
}

interface MarkJobFinishedResult {
  finalized: boolean;
  batch: BatchFinalizeCandidate;
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`[generation-batch] ${fieldName} 不能为空`);
  }
}

function assertCandidateIds(candidateIds: readonly string[]): void {
  if (candidateIds.length === 0) {
    throw new Error("[generation-batch] candidateIds 不能为空");
  }
  for (const candidateId of candidateIds) {
    assertNonEmpty(candidateId, "candidateId");
  }
}

function toBatchCandidate(row: LockedBatchRow): BatchFinalizeCandidate {
  return {
    shopId: row.shop_id,
    batchId: row.id,
    status: row.status,
    totalCount: row.total_count,
    completedCount: row.completed_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
  };
}

async function lockBatch(
  tx: TransactionClient,
  batchId: string,
): Promise<LockedBatchRow | null> {
  const rows = await tx.$queryRaw<LockedBatchRow[]>`
    SELECT id, shop_id, status, total_count, completed_count, skipped_count, failed_count
    FROM generation_batch
    WHERE id = ${batchId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
}

function resolveFinalStatus(batch: {
  failedCount: number;
  completedCount: number;
  totalCount: number;
}): GenerationBatchStatus {
  if (batch.completedCount < batch.totalCount) {
    return GenerationBatchStatus.IN_PROGRESS;
  }
  return batch.failedCount > 0
    ? GenerationBatchStatus.FAILED
    : GenerationBatchStatus.COMPLETED;
}

async function runCompletionSideEffects(
  batch: BatchFinalizeCandidate,
  options?: { autoWriteback?: boolean },
): Promise<void> {
  if (batch.status === GenerationBatchStatus.IN_PROGRESS) return;

  let unusedReleasedAmount = 0;
  try {
    const releaseResult = await GenerationCreditService.releaseUnusedReservation({
      shopId: batch.shopId,
      batchId: batch.batchId,
    });
    unusedReleasedAmount = releaseResult.releasedAmount;
  } catch (error) {
    logger.error(
      { shopId: batch.shopId, batchId: batch.batchId, err: error },
      "generation-batch.unused-release.failed",
    );
  }

  const lockResult = await releaseGenerateLock(batch.shopId, batch.batchId);

  logger.info(
    {
      shopId: batch.shopId,
      batchId: batch.batchId,
      status: batch.status,
      completedCount: batch.completedCount,
      totalCount: batch.totalCount,
      skippedCount: batch.skippedCount,
      failedCount: batch.failedCount,
      unusedReleasedAmount,
      lockReleased: lockResult.released,
    },
    "generation-batch.finalized",
  );

  // 审阅环节已砍掉：生成收尾后自动触发写回，无需人工确认。
  // 超时兜底路径不自动写回（批次已 stale，由运维关注）。
  if (options?.autoWriteback === false) return;

  try {
    await triggerAutoWriteback(batch);
  } catch (error) {
    // 自动写回失败不影响生成批次本身的终态，仅记录日志。
    logger.error(
      { shopId: batch.shopId, batchId: batch.batchId, err: error },
      "generation-batch.auto-writeback.failed",
    );
  }
}

/**
 * 生成完成后自动触发写回，并将写回批次 ID 回写到生成进度 Redis hash，
 * 供前端 SSE 快照透传展示写回进度/结果。
 */
async function triggerAutoWriteback(batch: BatchFinalizeCandidate): Promise<string | null> {
  const progressKey = getGenerationProgressKey(batch.batchId);

  const drafts = await prisma.altDraft.findMany({
    where: { batchId: batch.batchId },
    select: { altCandidateId: true },
  });

  if (drafts.length === 0) {
    await queueConnection.hset(progressKey, {
      writebackBatchId: "",
      writebackError: "",
    });
    logger.info(
      { shopId: batch.shopId, batchId: batch.batchId },
      "generation-batch.auto-writeback.skipped-empty",
    );
    return null;
  }

  const candidateIds = drafts.map((draft) => draft.altCandidateId);

  try {
    const result = await startWriteback(batch.shopId, candidateIds);
    await queueConnection.hset(progressKey, {
      writebackBatchId: result.batchId,
      writebackError: "",
    });
    logger.info(
      {
        shopId: batch.shopId,
        batchId: batch.batchId,
        writebackBatchId: result.batchId,
        totalQueued: result.totalQueued,
        rejectedCount: result.rejected.length,
      },
      "generation-batch.auto-writeback.started",
    );
    return result.batchId;
  } catch (error) {
    const code = error instanceof WritebackStartError ? error.code : "UNKNOWN";
    await queueConnection.hset(progressKey, {
      writebackBatchId: "",
      writebackError: code,
    });
    logger.warn(
      { shopId: batch.shopId, batchId: batch.batchId, code, err: error },
      "generation-batch.auto-writeback.rejected",
    );
    return null;
  }
}

export async function createBatch(
  shopId: string,
  candidateIds: readonly string[],
  client: PrismaClient = prisma,
): Promise<CreateBatchResult> {
  assertNonEmpty(shopId, "shopId");
  assertCandidateIds(candidateIds);

  const batch = await client.generationBatch.create({
    data: {
      shopId,
      totalCount: candidateIds.length,
      completedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      status: GenerationBatchStatus.IN_PROGRESS,
    },
  });

  logger.info(
    { shopId, batchId: batch.id, totalCount: batch.totalCount },
    "generation-batch.created",
  );

  return { batch };
}

export async function markJobFinished(
  params: MarkJobFinishedParams,
  client: PrismaClient = prisma,
): Promise<MarkJobFinishedResult> {
  const { shopId, batchId, result } = params;
  assertNonEmpty(shopId, "shopId");
  assertNonEmpty(batchId, "batchId");

  const finalizeCandidate = await client.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) {
      throw new Error(`[generation-batch] batch 不存在: ${batchId}`);
    }
    if (locked.shop_id !== shopId) {
      throw new Error(`[generation-batch] batch shop 不匹配: ${batchId}`);
    }
    if (locked.status !== GenerationBatchStatus.IN_PROGRESS) {
      return { finalizedNow: false, batch: toBatchCandidate(locked) };
    }

    const nextCompletedCount = locked.completed_count + 1;
    const nextSkippedCount =
      result === "skipped" ? locked.skipped_count + 1 : locked.skipped_count;
    const nextFailedCount =
      result === "failed" ? locked.failed_count + 1 : locked.failed_count;
    const nextStatus = resolveFinalStatus({
      failedCount: nextFailedCount,
      completedCount: nextCompletedCount,
      totalCount: locked.total_count,
    });

    const updated = await tx.generationBatch.update({
      where: { id: batchId },
      data: {
        completedCount: nextCompletedCount,
        skippedCount: nextSkippedCount,
        failedCount: nextFailedCount,
        status: nextStatus,
      },
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

    return {
      finalizedNow: nextStatus !== GenerationBatchStatus.IN_PROGRESS,
      batch: {
        shopId: updated.shopId,
        batchId: updated.id,
        status: updated.status,
        totalCount: updated.totalCount,
        completedCount: updated.completedCount,
        skippedCount: updated.skippedCount,
        failedCount: updated.failedCount,
      },
    };
  });

  if (finalizeCandidate.finalizedNow) {
    await runCompletionSideEffects(finalizeCandidate.batch);
  }

  return {
    finalized: finalizeCandidate.finalizedNow,
    batch: finalizeCandidate.batch,
  };
}

export async function finalizeTimedOutBatches(
  params: FinalizeTimedOutBatchesParams,
  client: PrismaClient = prisma,
): Promise<number> {
  if (!Number.isInteger(params.olderThanMinutes) || params.olderThanMinutes <= 0) {
    throw new Error("[generation-batch] olderThanMinutes 必须为正整数");
  }

  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - params.olderThanMinutes * 60_000);
  const batches = await client.generationBatch.findMany({
    where: {
      status: GenerationBatchStatus.IN_PROGRESS,
      createdAt: { lt: cutoff },
    },
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

  for (const batch of batches) {
    const updated = await client.generationBatch.updateMany({
      where: { id: batch.id, status: GenerationBatchStatus.IN_PROGRESS },
      data: { status: GenerationBatchStatus.FAILED },
    });

    if (updated.count !== 1) continue;

    // 回滚该 shop 下所有卡在 GENERATING 的候选人
    // 锁尚未释放（runCompletionSideEffects 中才释放 lock），不会与新的 batch 冲突
    try {
      const rollbackResult = await client.altCandidate.updateMany({
        where: {
          shopId: batch.shopId,
          status: AltCandidateStatus.GENERATING,
        },
        data: {
          status: AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
          errorCode: "BATCH_TIMEOUT",
          errorMessage: "Batch 超时自动回滚",
        },
      });

      if (rollbackResult.count > 0) {
        logger.info(
          { shopId: batch.shopId, batchId: batch.id, rolledBackCount: rollbackResult.count },
          "generation-batch.candidates-rolled-back",
        );
      }
    } catch (error) {
      logger.error(
        { shopId: batch.shopId, batchId: batch.id, err: error },
        "generation-batch.candidates-rollback-failed",
      );
    }

    await runCompletionSideEffects({
      shopId: batch.shopId,
      batchId: batch.id,
      status: GenerationBatchStatus.FAILED,
      totalCount: batch.totalCount,
      completedCount: batch.completedCount,
      skippedCount: batch.skippedCount,
      failedCount: batch.failedCount,
    }, { autoWriteback: false });
  }

  return batches.length;
}

export const GenerationBatchService = {
  createBatch,
  markJobFinished,
  finalizeTimedOutBatches,
};
