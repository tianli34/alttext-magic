/**
 * File: worker/processors/writeback.processor.ts
 * Purpose: 处理单条 writeback Job，串联二次读校验、Shopify 写回、审计落库与批次收尾。
 */
import { Session } from "@shopify/shopify-api";
import {
  AltCandidateStatus,
  JobBatchStatus,
  JobItemStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { env } from "../../server/config/env";
import { decryptToken } from "../../server/crypto/token-encryption";
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

interface ShopForSession {
  shopDomain: string;
  accessTokenEncrypted: string;
  accessTokenNonce: string;
  accessTokenTag: string;
  scopes: string | null;
}

export interface WritebackProcessorDependencies {
  prisma: PrismaClient;
  truthCheck(candidate: {
    candidateId: string;
    shopId: string;
    altPlane: WritebackJobData["altPlane"];
    writeTargetId: string;
  }): Promise<TruthCheckResult>;
  getExecutor(altPlane: WritebackJobData["altPlane"]): MutationExecutor;
  releaseLock(shopId: string, lockId: string): Promise<void>;
  now(): Date;
}

const defaultRouter = new WritebackRouter();

const defaultDependencies: WritebackProcessorDependencies = {
  prisma,
  truthCheck: (candidate) => TruthCheckService.checkCurrentAlt(candidate),
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
  const shop = await loadShop(data.shopId, dependencies.prisma);
  const session = createOfflineSession(shop);
  const result = await dependencies.getExecutor(candidate.altTarget.altPlane).execute({
    session,
    shopifyGid: candidate.altTarget.writeTargetId,
    altText,
  });

  if (result.success) {
    await markWritten(data, candidate, altText, truth.currentAlt, jobLogger, dependencies);
    // ── 指标：写回成功 ──
    recordMetric("writeback.success", 1, {
      shop_domain: data.shopId,
      batch_id: data.batchId,
    });
    await finalizeBatchIfComplete(data, jobLogger, dependencies);
    return;
  }

  await markWritebackJobFailed(data, result.error, jobLogger, dependencies);
  // ── 指标：写回失败 ──
  recordMetric("writeback.fail.WRITEBACK_FAILED", 1, {
    shop_domain: data.shopId,
    batch_id: data.batchId,
    error_code: "WRITEBACK_FAILED",
  });
  await finalizeBatchIfComplete(data, jobLogger, dependencies);
}

export async function markWritebackJobFailed(
  data: WritebackJobData,
  errorMessage: string,
  log: ExtendedLogger = logger,
  dependencies: WritebackProcessorDependencies = defaultDependencies,
): Promise<void> {
  const message = truncateError(errorMessage);

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
        status: AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
        errorCode: "WRITEBACK_FAILED",
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
      error_code: "WRITEBACK_FAILED",
      error_message: message,
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

async function loadShop(shopId: string, client: PrismaClient): Promise<ShopForSession> {
  const shop = await client.shop.findUnique({
    where: { id: shopId },
    select: {
      shopDomain: true,
      accessTokenEncrypted: true,
      accessTokenNonce: true,
      accessTokenTag: true,
      scopes: true,
    },
  });

  if (!shop) {
    throw new Error(`[writeback] shop 不存在: ${shopId}`);
  }

  return shop;
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

function createOfflineSession(shop: ShopForSession): Session {
  return new Session({
    id: `offline_${shop.shopDomain}`,
    shop: shop.shopDomain,
    state: "",
    isOnline: false,
    scope: shop.scopes ?? undefined,
    accessToken: decryptToken(
      shop.accessTokenEncrypted,
      shop.accessTokenNonce,
      shop.accessTokenTag,
    ),
  });
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

async function markWritten(
  data: WritebackJobData,
  candidate: CandidateForWriteback,
  altText: string,
  oldAltText: string | null,
  log: ExtendedLogger,
  dependencies: WritebackProcessorDependencies,
): Promise<void> {
  const writtenAt = dependencies.now();

  await dependencies.prisma.$transaction(async (tx) => {
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

    if (updatedItem.count !== 1) return;

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

    await tx.altDraft.update({
      where: { altCandidateId: candidate.id },
      data: {
        finalText: altText,
      },
    });

    await tx.altCandidate.update({
      where: { id: candidate.id },
      data: {
        status: AltCandidateStatus.WRITTEN,
        writtenAt,
        errorCode: null,
        errorMessage: null,
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
  });

  log.info(
    {
      shopId: data.shopId,
    },
    "writeback.written",
  );
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
