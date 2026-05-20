/**
 * File: server/modules/writeback/writeback.service.ts
 * Purpose: 写回启动服务，负责候选校验、WRITEBACK 批次创建与 BullMQ 投递。
 */
import {
  AltCandidateStatus,
  JobBatchStatus,
  JobBatchType,
  type AltPlane,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import prisma from "../../db/prisma.server";
import {
  acquireWritebackLock,
  releaseWritebackLock,
  type AcquireWritebackLockResult,
} from "../lock/writeback-lock.service";
import { isOperationRunning } from "../lock/operation-lock.service";
import { enqueueWritebackJob, type WritebackJobData } from "../../queues/writeback.queue";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "writeback-start-service" });

const WRITEBACK_ALLOWED_STATUSES = [
  AltCandidateStatus.GENERATED,
  AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
] as const;

const WRITEBACK_ALLOWED_STATUS_SET = new Set<AltCandidateStatus>(
  WRITEBACK_ALLOWED_STATUSES,
);

export type WritebackRejectReason =
  | "NOT_FOUND"
  | "INVALID_STATUS"
  | "DECORATIVE"
  | "NO_DRAFT";

export interface WritebackRejectedCandidate {
  candidateId: string;
  reason: WritebackRejectReason;
}

export interface StartWritebackResult {
  batchId: string;
  totalQueued: number;
  rejected: WritebackRejectedCandidate[];
}

export class WritebackStartError extends Error {
  constructor(
    readonly code:
      | "WRITEBACK_LOCK_ACTIVE"
      | "SCAN_LOCK_ACTIVE"
      | "NO_VALID_CANDIDATES",
    message: string,
    readonly rejected: WritebackRejectedCandidate[] = [],
  ) {
    super(message);
    this.name = "WritebackStartError";
  }
}

export interface WritebackStartDependencies {
  prisma: Pick<PrismaClient, "altCandidate" | "jobBatch" | "$transaction">;
  isWritebackLocked(shopId: string): Promise<boolean>;
  isScanRunning(shopId: string): Promise<boolean>;
  acquireWritebackLock(shopId: string): Promise<AcquireWritebackLockResult>;
  releaseWritebackLock(shopId: string, lockId: string): Promise<void>;
  enqueueWritebackJob(data: WritebackJobData): Promise<void>;
}

type CandidateForWriteback = Prisma.AltCandidateGetPayload<{
  include: {
    altTarget: {
      include: {
        decorativeMark: true;
      };
    };
    draft: true;
  };
}>;

interface ValidWritebackCandidate {
  candidateId: string;
  altPlane: AltPlane;
  shopifyGid: string;
  altText: string;
}

const defaultDependencies: WritebackStartDependencies = {
  prisma,
  isWritebackLocked: async (shopId) => {
    const { isWritebackLocked } = await import("../lock/writeback-lock.service");
    return isWritebackLocked(shopId);
  },
  isScanRunning: (shopId) => isOperationRunning(shopId, "SCAN"),
  acquireWritebackLock,
  releaseWritebackLock,
  enqueueWritebackJob,
};

export async function startWriteback(
  shopId: string,
  candidateIds: string[],
  dependencies: WritebackStartDependencies = defaultDependencies,
): Promise<StartWritebackResult> {
  const writebackLocked = await dependencies.isWritebackLocked(shopId);
  if (writebackLocked) {
    throw new WritebackStartError(
      "WRITEBACK_LOCK_ACTIVE",
      "A writeback is already running. Please try again later.",
    );
  }

  const scanRunning = await dependencies.isScanRunning(shopId);
  if (scanRunning) {
    throw new WritebackStartError(
      "SCAN_LOCK_ACTIVE",
      "A scan is currently running. Please try again later.",
    );
  }

  const candidates = await dependencies.prisma.altCandidate.findMany({
    where: {
      id: { in: candidateIds },
      shopId,
    },
    include: {
      altTarget: {
        include: {
          decorativeMark: true,
        },
      },
      draft: true,
    },
  });

  const validation = validateWritebackCandidates(candidateIds, candidates);
  if (validation.valid.length === 0) {
    throw new WritebackStartError(
      "NO_VALID_CANDIDATES",
      "No candidates are eligible for writeback.",
      validation.rejected,
    );
  }

  const lockResult = await dependencies.acquireWritebackLock(shopId);
  if (!lockResult.acquired) {
    const code = lockResult.reason === "SCAN_LOCK_ACTIVE"
      ? "SCAN_LOCK_ACTIVE"
      : "WRITEBACK_LOCK_ACTIVE";
    throw new WritebackStartError(
      code,
      code === "SCAN_LOCK_ACTIVE"
        ? "A scan is currently running. Please try again later."
        : "A writeback is already running. Please try again later.",
      validation.rejected,
    );
  }

  let batchId: string | null = null;

  try {
    const batch = await dependencies.prisma.$transaction(async (tx) => {
      const createdBatch = await tx.jobBatch.create({
        data: {
          shopId,
          type: JobBatchType.WRITEBACK,
          status: JobBatchStatus.RUNNING,
          total: validation.valid.length,
          items: {
            create: validation.valid.map((candidate) => ({
              altCandidateId: candidate.candidateId,
            })),
          },
        },
        select: {
          id: true,
        },
      });

      return createdBatch;
    });
    batchId = batch.id;

    for (const candidate of validation.valid) {
      await dependencies.enqueueWritebackJob({
        shopId,
        candidateId: candidate.candidateId,
        batchId,
        lockId: lockResult.lockId,
        altPlane: candidate.altPlane,
        shopifyGid: candidate.shopifyGid,
        altText: candidate.altText,
      });
    }

    logger.info(
      {
        shopId,
        batchId,
        totalQueued: validation.valid.length,
        rejectedCount: validation.rejected.length,
      },
      "writeback.start.created",
    );

    return {
      batchId,
      totalQueued: validation.valid.length,
      rejected: validation.rejected,
    };
  } catch (error) {
    await rollbackWritebackStart(dependencies, shopId, lockResult.lockId, batchId);
    logger.error({ shopId, batchId, err: error }, "writeback.start.failed");
    throw error;
  }
}

export function validateWritebackCandidates(
  requestedIds: string[],
  candidates: CandidateForWriteback[],
): {
  valid: ValidWritebackCandidate[];
  rejected: WritebackRejectedCandidate[];
} {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const valid: ValidWritebackCandidate[] = [];
  const rejected: WritebackRejectedCandidate[] = [];

  for (const candidateId of requestedIds) {
    const candidate = byId.get(candidateId);
    if (!candidate) {
      rejected.push({ candidateId, reason: "NOT_FOUND" });
      continue;
    }

    if (!WRITEBACK_ALLOWED_STATUS_SET.has(candidate.status)) {
      rejected.push({ candidateId, reason: "INVALID_STATUS" });
      continue;
    }

    if (candidate.altTarget.decorativeMark?.isActive === true) {
      rejected.push({ candidateId, reason: "DECORATIVE" });
      continue;
    }

    if (!candidate.draft) {
      rejected.push({ candidateId, reason: "NO_DRAFT" });
      continue;
    }

    const displayText = candidate.draft.editedText?.trim()
      || candidate.draft.generatedText.trim();

    if (displayText.length === 0) {
      rejected.push({ candidateId, reason: "NO_DRAFT" });
      continue;
    }

    valid.push({
      candidateId,
      altPlane: candidate.altTarget.altPlane,
      shopifyGid: candidate.altTarget.writeTargetId,
      altText: displayText,
    });
  }

  return { valid, rejected };
}

async function rollbackWritebackStart(
  dependencies: WritebackStartDependencies,
  shopId: string,
  lockId: string,
  batchId: string | null,
): Promise<void> {
  try {
    await dependencies.releaseWritebackLock(shopId, lockId);
  } catch (error) {
    logger.warn({ shopId, lockId, err: error }, "writeback.start.rollback.lock-release-failed");
  }

  if (!batchId) return;

  try {
    await dependencies.prisma.jobBatch.update({
      where: { id: batchId },
      data: {
        status: JobBatchStatus.FAILED,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    logger.warn({ shopId, batchId, err: error }, "writeback.start.rollback.batch-fail-failed");
  }
}
