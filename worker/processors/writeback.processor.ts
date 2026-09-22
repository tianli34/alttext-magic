/**
 * File: worker/processors/writeback.processor.ts
 * Purpose: 处理单条 writeback Job，串联二次读校验、Shopify 写回、审计落库与批次收尾。
 */
import type { Session } from "@shopify/shopify-api";
import {
  AltCandidateStatus,
  JobBatchStatus,
  JobItemStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { env } from "../../server/config/env";
import prisma from "../../server/db/prisma.server";
import {
  TruthCheckService,
  type TruthCheckResult,
} from "../../server/modules/generation/truth-check.service";
import { releaseWritebackLock } from "../../server/modules/lock/writeback-lock.service";
import { WritebackRouter } from "../../server/modules/writeback/writeback-router";
import type {
  MutationExecutor,
  WritebackResult,
} from "../../server/modules/writeback/writeback.types";
import type { WritebackJobData } from "../../server/queues/writeback.queue";
import { createLogger, type ExtendedLogger } from "../../server/utils/logger";
import { getOfflineAdminByShopId } from "../../server/shopify/offline-admin.server";
import { recordMetric } from "../../shared/logger/metrics";

const logger = createLogger({ module: "writeback-processor" });

export const writebackConcurrency = env.WRITEBACK_CONCURRENCY;

const PROCESSABLE_STATUSES = [
  AltCandidateStatus.GENERATED,
  AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
] as const;

const PROCESSABLE_STATUS_SET = new Set<AltCandidateStatus>(PROCESSABLE_STATUSES);

type CandidateForWriteback = Prisma.AltCandidateGetPayload<{
  include: {
    altTarget: true;
    draft: true;
  };
}>;

export interface WritebackProcessorDependencies {
  prisma: PrismaClient;
  truthCheck(candidate: {
    candidateId: string;
    shopId: string;
    altPlane: WritebackJobData["altPlane"];
    writeTargetId: string;
  }): Promise<TruthCheckResult>;
  getAdminSession(shopId: string): Promise<Session>;
  getExecutor(altPlane: WritebackJobData["altPlane"]): MutationExecutor;
  releaseLock(shopId: string, lockId: string): Promise<void>;
  now(): Date;
}

const defaultRouter = new WritebackRouter();

const defaultDependencies: WritebackProcessorDependencies = {
  prisma,
  truthCheck: (candidate) => TruthCheckService.checkCurrentAlt(candidate),
  getAdminSession: async (shopId) => {
    const { session } = await getOfflineAdminByShopId(shopId);
    return session;
  },
  getExecutor: (altPlane) => defaultRouter.getExecutor(altPlane),
  releaseLock: releaseWritebackLock,
  now: () => new Date(),
};

export async function processWritebackJob(
  data: WritebackJobData,
  dependencies: WritebackProcessorDependencies = defaultDependencies,
): Promise<void> {
  const candidate = await loadCandidate(data, dependencies.prisma);

  const jobLogger = logger.withContext({
    batch_id: data.batchId,
    alt_plane: candidate.altTarget.altPlane,
    job_item_id: candidate.id,
    write_target_id: candidate.altTarget.writeTargetId,
  });

  if (!PROCESSABLE_STATUS_SET.has(candidate.status)) {
    jobLogger.info(
      {
        shopId: data.shopId,
        status: candidate.status,
      },
      "writeback.non-processable-skip",
    );
    return;
  }

  const claimed = await claimJobItem(data, dependencies.prisma);
  if (!claimed) {
    jobLogger.info(
      { shopId: data.shopId },
      "writeback.job-item-terminal-skip",
    );
    return;
  }

  const truth = await dependencies.truthCheck({
    candidateId: candidate.id,
    shopId: data.shopId,
    altPlane: candidate.altTarget.altPlane,
    writeTargetId: candidate.altTarget.writeTargetId,
  });

  if (!truth.isEmpty) {
    await markSkippedAlreadyFilled(data, candidate, truth.currentAlt ?? "", jobLogger, dependencies);
    await finalizeBatchIfComplete(data, jobLogger, dependencies);
    return;
  }

  const altText = resolveAltText(candidate);
  const session = await dependencies.getAdminSession(data.shopId);
  const result = await dependencies.getExecutor(candidate.altTarget.altPlane).execute({
    session,
    shopifyGid: candidate.altTarget.writeTargetId,
    altText,
  });

  if (result.success) {
    const applied = await markWritten(data, candidate, altText, truth.currentAlt, jobLogger, dependencies);
    // ── 指标：写回成功（仅实际落库时计数；状态冲突走补偿路径，不计成功）──
    if (applied) {
      recordMetric("writeback.success", 1, {
        shop_domain: data.shopId,
        batch_id: data.batchId,
      });
    }
    await finalizeBatchIfComplete(data, jobLogger, dependencies);
    return;
  }

  await markWritebackJobFailed(data, result, jobLogger, dependencies);
  // ── 指标：写回失败（按错误码区分认证失效与普通失败）──
  const errorCode = result.errorCode ?? "WRITEBACK_FAILED";
  recordMetric(`writeback.fail.${errorCode}`, 1, {
    shop_domain: data.shopId,
    batch_id: data.batchId,
    error_code: errorCode,
  });
  await finalizeBatchIfComplete(data, jobLogger, dependencies);
}

export async function markWritebackJobFailed(
  data: WritebackJobData,
  failure: Extract<WritebackResult, { success: false }>,
  log: ExtendedLogger = logger,
  dependencies: WritebackProcessorDependencies = defaultDependencies,
): Promise<void> {
  const message = truncateError(failure.error);
  const errorCode = failure.errorCode ?? "WRITEBACK_FAILED";
  // retryable=false 表示认证失效等不可自愈错误：进入终态 WRITEBACK_FAILED_PERMANENT，
  // 不再允许写回重试；条件修复（如店铺重新授权）后可经重新扫描恢复为 GENERATED
  const candidateStatus = failure.retryable
    ? AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE
    : AltCandidateStatus.WRITEBACK_FAILED_PERMANENT;

  await dependencies.prisma.$transaction(async (tx) => {
    const updatedItem = await tx.jobItem.updateMany({
      where: {
        batchId: data.batchId,
        altCandidateId: data.candidateId,
        status: { in: [JobItemStatus.PENDING, JobItemStatus.RUNNING] },
      },
      data: {
        status: JobItemStatus.FAILED,
        error: message,
      },
    });

    if (updatedItem.count !== 1) return;

    await tx.altCandidate.updateMany({
      where: {
        id: data.candidateId,
        shopId: data.shopId,
        status: { in: [...PROCESSABLE_STATUSES] },
      },
      data: {
        status: candidateStatus,
        errorCode,
        errorMessage: message,
      },
    });

    await tx.jobBatch.update({
      where: { id: data.batchId },
      data: {
        failed: { increment: 1 },
      },
    });
  });

  log.error(
    {
      shopId: data.shopId,
      error_code: errorCode,
      error_message: message,
      retryable: failure.retryable,
    },
    "writeback.failed",
  );
}

export async function finalizeBatchIfComplete(
  data: Pick<WritebackJobData, "shopId" | "batchId" | "lockId">,
  log: ExtendedLogger = logger,
  dependencies: WritebackProcessorDependencies = defaultDependencies,
): Promise<void> {
  const batch = await dependencies.prisma.jobBatch.findUnique({
    where: { id: data.batchId },
    select: {
      total: true,
      success: true,
      failed: true,
      skipped: true,
      status: true,
    },
  });

  if (!batch || batch.status !== JobBatchStatus.RUNNING) return;

  const finishedCount = batch.success + batch.failed + batch.skipped;
  if (finishedCount < batch.total) return;

  const status = resolveFinalBatchStatus(batch);
  const updated = await dependencies.prisma.jobBatch.updateMany({
    where: {
      id: data.batchId,
      status: JobBatchStatus.RUNNING,
    },
    data: {
      status,
      finishedAt: dependencies.now(),
    },
  });

  if (updated.count !== 1) return;

  await dependencies.releaseLock(data.shopId, data.lockId);

  log.info(
    {
      shopId: data.shopId,
      status,
      total: batch.total,
      success: batch.success,
      failed: batch.failed,
      skipped: batch.skipped,
    },
    "writeback.batch-finalized",
  );

  // ── 指标：写回批次完成率 ──
  const rate = batch.total > 0 ? batch.success / batch.total : 0;
  recordMetric("writeback.rate", rate, {
    shop_domain: data.shopId,
    batch_id: data.batchId,
    total: batch.total,
    success: batch.success,
    failed: batch.failed,
    skipped: batch.skipped,
  });
}

async function loadCandidate(
  data: WritebackJobData,
  client: PrismaClient,
): Promise<CandidateForWriteback> {
  const candidate = await client.altCandidate.findFirst({
    where: {
      id: data.candidateId,
      shopId: data.shopId,
    },
    include: {
      altTarget: true,
      draft: {
        where: { expiresAt: { gt: new Date() } },
      },
    },
  });

  if (!candidate) {
    throw new Error(`[writeback] candidate 不存在: ${data.candidateId}`);
  }

  if (!candidate.draft) {
    throw new Error(`[writeback] candidate 缺少 draft: ${data.candidateId}`);
  }

  return candidate;
}

async function claimJobItem(
  data: WritebackJobData,
  client: PrismaClient,
): Promise<boolean> {
  const pending = await client.jobItem.updateMany({
    where: {
      batchId: data.batchId,
      altCandidateId: data.candidateId,
      status: JobItemStatus.PENDING,
    },
    data: {
      status: JobItemStatus.RUNNING,
    },
  });

  if (pending.count === 1) return true;

  const item = await client.jobItem.findUnique({
    where: {
      batchId_altCandidateId: {
        batchId: data.batchId,
        altCandidateId: data.candidateId,
      },
    },
    select: { status: true },
  });

  return item?.status === JobItemStatus.RUNNING;
}

function resolveAltText(candidate: CandidateForWriteback): string {
  const editedText = candidate.draft?.editedText?.trim();
  if (editedText && editedText.length > 0) return editedText;

  const generatedText = candidate.draft?.generatedText.trim();
  if (generatedText && generatedText.length > 0) return generatedText;

  throw new Error(`[writeback] candidate draft 文本为空: ${candidate.id}`);
}

async function markSkippedAlreadyFilled(
  data: WritebackJobData,
  candidate: CandidateForWriteback,
  currentAlt: string,
  log: ExtendedLogger,
  dependencies: WritebackProcessorDependencies,
): Promise<void> {
  await dependencies.prisma.$transaction(async (tx) => {
    const updatedItem = await tx.jobItem.updateMany({
      where: {
        batchId: data.batchId,
        altCandidateId: data.candidateId,
        status: JobItemStatus.RUNNING,
      },
      data: {
        status: JobItemStatus.SKIPPED_ALREADY_FILLED,
      },
    });

    if (updatedItem.count !== 1) return;

    await tx.altCandidate.updateMany({
      where: {
        id: candidate.id,
        shopId: data.shopId,
        status: { in: [...PROCESSABLE_STATUSES] },
      },
      data: {
        status: AltCandidateStatus.RESOLVED,
        errorCode: null,
        errorMessage: null,
      },
    });

    await tx.altTarget.update({
      where: { id: candidate.altTargetId },
      data: {
        currentAltText: currentAlt,
        currentAltEmpty: false,
      },
    });

    await tx.jobBatch.update({
      where: { id: data.batchId },
      data: {
        skipped: { increment: 1 },
      },
    });
  });

  log.info(
    {
      shopId: data.shopId,
    },
    "跳过，商家已手动补 Alt",
  );
}

/**
 * 落库写回成功。返回是否实际落库：
 * - `true`：候选状态正常，WRITTEN 及关联写已提交（重复投递的幂等跳过也返回 true，保持既有指标语义）。
 * - `false`：候选在落库前被并发方接管，已走补偿路径（jobItem 转 FAILED），调用方不应再计成功指标。
 */
async function markWritten(
  data: WritebackJobData,
  candidate: CandidateForWriteback,
  altText: string,
  oldAltText: string | null,
  log: ExtendedLogger,
  dependencies: WritebackProcessorDependencies,
): Promise<boolean> {
  const writtenAt = dependencies.now();

  const applied = await dependencies.prisma.$transaction(async (tx) => {
    const updatedItem = await tx.jobItem.updateMany({
      where: {
        batchId: data.batchId,
        altCandidateId: data.candidateId,
        status: JobItemStatus.RUNNING,
      },
      data: {
        status: JobItemStatus.SUCCESS,
        error: null,
      },
    });

    if (updatedItem.count !== 1) return true;

    const jobItem = await tx.jobItem.findUnique({
      where: {
        batchId_altCandidateId: {
          batchId: data.batchId,
          altCandidateId: data.candidateId,
        },
      },
      select: { id: true },
    });

    if (!jobItem) {
      throw new Error(`[writeback] job item 不存在: ${data.batchId}/${data.candidateId}`);
    }

    // 条件写：仅当候选仍处于可写回状态才落 WRITTEN，避免覆盖并发变更
    //（如用户在此期间标记装饰性图片）。同时补上 shopId 租户隔离条件，
    // 与本文件其他候选写保持一致。
    const updatedCandidate = await tx.altCandidate.updateMany({
      where: {
        id: candidate.id,
        shopId: data.shopId,
        status: { in: [...PROCESSABLE_STATUSES] },
      },
      data: {
        status: AltCandidateStatus.WRITTEN,
        writtenAt,
        errorCode: null,
        errorMessage: null,
      },
    });

    if (updatedCandidate.count !== 1) {
      // 补偿：Shopify 写回已成功，但候选状态已被并发方接管，不做覆盖；
      // 将本 jobItem 转为 FAILED 以便批次正常收敛，候选保持并发方的状态。
      const conflictError = "[CANDIDATE_STATUS_CHANGED] candidate 状态在写回落库前发生并发变更";
      await tx.jobItem.updateMany({
        where: {
          batchId: data.batchId,
          altCandidateId: data.candidateId,
          status: JobItemStatus.SUCCESS,
        },
        data: {
          status: JobItemStatus.FAILED,
          error: conflictError,
        },
      });
      await tx.jobBatch.update({
        where: { id: data.batchId },
        data: {
          failed: { increment: 1 },
        },
      });
      log.warn(
        {
          shopId: data.shopId,
          candidateId: candidate.id,
        },
        "writeback.status-conflict-skipped",
      );
      return false;
    }

    await tx.altDraft.update({
      where: { altCandidateId: candidate.id },
      data: {
        finalText: altText,
      },
    });

    await tx.altTarget.update({
      where: { id: candidate.altTargetId },
      data: {
        currentAltText: altText,
        currentAltEmpty: false,
      },
    });

    await tx.auditLog.create({
      data: {
        shopId: data.shopId,
        jobBatchId: data.batchId,
        jobItemId: jobItem.id,
        altTargetId: candidate.altTargetId,
        altCandidateId: candidate.id,
        altDraftId: candidate.draft?.id ?? null,
        idempotencyKey: `writeback:${data.batchId}:${data.candidateId}`,
        altPlane: candidate.altTarget.altPlane,
        writeTargetId: candidate.altTarget.writeTargetId,
        oldAltText,
        newAltText: altText,
        modelUsed: candidate.draft?.modelUsed ?? "unknown",
        writtenAt,
      },
    });

    await tx.jobBatch.update({
      where: { id: data.batchId },
      data: {
        success: { increment: 1 },
      },
    });

    return true;
  });

  if (!applied) return false;

  log.info(
    {
      shopId: data.shopId,
    },
    "writeback.written",
  );

  return true;
}

function resolveFinalBatchStatus(batch: {
  success: number;
  failed: number;
  skipped: number;
}): JobBatchStatus {
  if (batch.failed === 0) return JobBatchStatus.SUCCESS;
  if (batch.success + batch.skipped > 0) return JobBatchStatus.PARTIAL_SUCCESS;
  return JobBatchStatus.FAILED;
}

function truncateError(message: string): string {
  return message.length > 1_000 ? `${message.slice(0, 997)}...` : message;
}
