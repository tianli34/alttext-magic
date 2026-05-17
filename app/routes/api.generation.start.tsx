/**
 * File: app/routes/api.generation.start.tsx
 * Purpose: POST /api/generation/start —— 校验候选、预检额度、预留额度并投递生成任务。
 */
import {
  AltCandidateStatus,
  CandidateGroupType,
  type CreditReservationLine,
  type Prisma,
} from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createReservation,
  InsufficientCreditError,
  releaseReservation,
  type CreditReservationWithLines,
} from "../services/credits/credit-reservation.server";
import { acquireGenerateLock, releaseGenerateLock } from "../../server/modules/lock/generate-lock.service";
import { GenerationBatchService } from "../../server/modules/generation/generation-batch.service";
import { enqueueGenerateAltJob } from "../../server/queues/generate-alt.queue";
import { initGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
import {
  getCreditBalance,
  planCreditAllocation,
  type AllocationEntry,
  type CreditBalanceResult,
} from "../../server/modules/billing/credit/credit-balance.server";
import { isIncludedFamily } from "../../server/modules/billing/credit/consumption-order";
import { getScopeSettings } from "../../server/modules/shop/scope.service";
import type { ScanScopeFlags } from "../../server/modules/shop/shop.types";

const logger = createLogger({ module: "api.generation.start" });

const startBodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1),
});

const GENERATABLE_STATUSES = [
  AltCandidateStatus.MISSING,
  AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
] as const;
const GENERATABLE_STATUS_SET = new Set<AltCandidateStatus>(GENERATABLE_STATUSES);

class StartValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly candidateIds: string[] = [],
  ) {
    super(message);
    this.name = "StartValidationError";
  }
}

interface CreditPreflightResult {
  estimatedCredits: number;
  enough: boolean;
  balance: CreditBalanceResult;
  allocation: Array<{ bucketType: string; amount: number }>;
}

export const loader = () => {
  return Response.json(
    { error: "Method not allowed. Use POST." },
    { status: 405 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for generation start");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const parsed = await parseRequestBody(request);
  if (parsed instanceof Response) return parsed;

  const candidateIds = Array.from(new Set(parsed.candidateIds));
  if (candidateIds.length !== parsed.candidateIds.length) {
    return validationResponse(new StartValidationError(
      "DUPLICATE_CANDIDATE_IDS",
      "candidateIds must be unique",
    ));
  }

  const existingLock = await findBlockingLock(shop.id);
  if (existingLock) {
    return lockConflictResponse(existingLock.lockType);
  }

  const candidates = await loadAndValidateCandidates(shop.id, candidateIds);
  if (candidates instanceof Response) return candidates;

  const preflight = await runCreditPreflight(shop.id, candidateIds.length);
  if (!preflight.enough) {
    return Response.json(
      {
        error: "INSUFFICIENT_CREDIT",
        ...creditDetailPayload(preflight),
      },
      { status: 409 },
    );
  }

  let batchId: string | null = null;
  let reservationId: string | null = null;
  let lockAcquired = false;

  try {
    const { batch } = await GenerationBatchService.createBatch(shop.id, candidateIds);
    batchId = batch.id;

    const reservationResult = await createReservation({
      shopId: shop.id,
      batchId,
      amount: candidates.length,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    reservationId = reservationResult.reservation.id;

    const lockResult = await acquireGenerateLock(shop.id, batchId);
    if (!lockResult.acquired) {
      throw new StartValidationError(
        "LOCK_CONFLICT",
        "Shop has a running operation lock",
        [],
      );
    }
    lockAcquired = true;

    await initGenerationProgress(batchId, candidates.length);

    for (const candidate of candidates) {
      await enqueueGenerateAltJob({
        batchId,
        reservationId,
        candidateId: candidate.id,
        shopId: shop.id,
        shopifyImageId: candidate.altTarget.writeTargetId,
        altPlane: candidate.altTarget.altPlane,
        imageUrl: candidate.altTarget.previewUrl!,
      });
    }

    await prisma.altCandidate.updateMany({
      where: {
        id: { in: candidateIds },
        shopId: shop.id,
        status: { in: [...GENERATABLE_STATUSES] },
      },
      data: {
        status: AltCandidateStatus.GENERATING,
        errorCode: null,
        errorMessage: null,
      },
    });

    logger.info(
      { shopId: shop.id, batchId, totalCount: candidates.length, reservationId },
      "Generation started",
    );

    return Response.json({
      batchId,
      totalCount: candidates.length,
      reservation: reservationPayload(reservationResult.reservation),
    });
  } catch (error) {
    if (error instanceof StartValidationError && error.code === "LOCK_CONFLICT") {
      await rollbackGenerationStart(shop.id, batchId, reservationId, lockAcquired);
      return lockConflictResponse("GENERATE");
    }

    if (error instanceof InsufficientCreditError) {
      const latestPreflight = await runCreditPreflight(shop.id, candidateIds.length);
      await rollbackGenerationStart(shop.id, batchId, reservationId, lockAcquired);
      return Response.json(
        {
          error: "INSUFFICIENT_CREDIT",
          requested: error.requested,
          available: error.available,
          ...creditDetailPayload(latestPreflight),
        },
        { status: 409 },
      );
    }

    logger.error({ shopId: shop.id, batchId, reservationId, err: error }, "Failed to start generation");
    await rollbackGenerationStart(shop.id, batchId, reservationId, lockAcquired);

    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};

async function parseRequestBody(
  request: Request,
): Promise<z.infer<typeof startBodySchema> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    return startBodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid request body",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}

async function findBlockingLock(
  shopId: string,
): Promise<{ lockType: string } | null> {
  const lock = await prisma.shopOperationLock.findUnique({
    where: { shopId },
    select: { lockType: true, status: true, expiresAt: true },
  });

  if (
    lock?.status === "RUNNING" &&
    lock.expiresAt.getTime() > Date.now() &&
    (lock.lockType === "SCAN" || lock.lockType === "GENERATE")
  ) {
    return { lockType: lock.lockType };
  }

  return null;
}

async function loadAndValidateCandidates(shopId: string, candidateIds: string[]): Promise<CandidateForStart[] | Response> {
  const [candidates, scopeSettings] = await Promise.all([
    prisma.altCandidate.findMany({
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
        groupProjections: {
          select: {
            groupType: true,
          },
        },
      },
    }),
    getScopeSettings(shopId),
  ]);

  try {
    validateCandidateSet(candidateIds, candidates, scopeSettings.effectiveReadScopeFlags);
    return sortCandidatesByInput(candidateIds, candidates);
  } catch (error) {
    if (error instanceof StartValidationError) {
      return validationResponse(error);
    }
    throw error;
  }
}

type CandidateForStart = Prisma.AltCandidateGetPayload<{
  include: {
    altTarget: { include: { decorativeMark: true } };
    groupProjections: { select: { groupType: true } };
  };
}>;

function validateCandidateSet(
  requestedIds: string[],
  candidates: CandidateForStart[],
  effectiveReadScopeFlags: ScanScopeFlags,
): void {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const missingIds = requestedIds.filter((candidateId) => !byId.has(candidateId));
  if (missingIds.length > 0) {
    throw new StartValidationError(
      "CANDIDATE_NOT_FOUND",
      "Some candidates do not belong to this shop or do not exist",
      missingIds,
    );
  }

  const invalidStatusIds = candidates
    .filter((candidate) => !GENERATABLE_STATUS_SET.has(candidate.status))
    .map((candidate) => candidate.id);
  if (invalidStatusIds.length > 0) {
    throw new StartValidationError(
      "INVALID_CANDIDATE_STATUS",
      "Candidates must be MISSING or GENERATION_FAILED_RETRYABLE",
      invalidStatusIds,
    );
  }

  const decorativeIds = candidates
    .filter((candidate) => candidate.altTarget.decorativeMark?.isActive === true)
    .map((candidate) => candidate.id);
  if (decorativeIds.length > 0) {
    throw new StartValidationError(
      "DECORATIVE_CANDIDATE",
      "Decorative candidates cannot be generated",
      decorativeIds,
    );
  }

  const missingPreviewIds = candidates
    .filter((candidate) => !candidate.altTarget.previewUrl)
    .map((candidate) => candidate.id);
  if (missingPreviewIds.length > 0) {
    throw new StartValidationError(
      "MISSING_PREVIEW_URL",
      "Candidates must have previewUrl",
      missingPreviewIds,
    );
  }

  const unauthorizedIds = candidates
    .filter((candidate) => !isCandidateScopeAuthorized(candidate, effectiveReadScopeFlags))
    .map((candidate) => candidate.id);
  if (unauthorizedIds.length > 0) {
    throw new StartValidationError(
      "SCOPE_NOT_AUTHORIZED",
      "Candidate scope is not authorized",
      unauthorizedIds,
    );
  }
}

function isCandidateScopeAuthorized(
  candidate: CandidateForStart,
  effectiveReadScopeFlags: ScanScopeFlags,
): boolean {
  return candidate.groupProjections.some((projection) => {
    const scopeFlag = groupTypeToScopeFlag(projection.groupType);
    return effectiveReadScopeFlags[scopeFlag];
  });
}

function groupTypeToScopeFlag(groupType: CandidateGroupType): keyof ScanScopeFlags {
  switch (groupType) {
    case CandidateGroupType.PRODUCT_MEDIA:
      return "PRODUCT_MEDIA";
    case CandidateGroupType.FILES:
      return "FILES";
    case CandidateGroupType.COLLECTION:
      return "COLLECTION_IMAGE";
    case CandidateGroupType.ARTICLE:
      return "ARTICLE_IMAGE";
    default: {
      const exhaustive: never = groupType;
      return exhaustive;
    }
  }
}

function sortCandidatesByInput(
  requestedIds: string[],
  candidates: CandidateForStart[],
): CandidateForStart[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return requestedIds.map((candidateId) => byId.get(candidateId)!);
}

async function runCreditPreflight(shopId: string, count: number): Promise<CreditPreflightResult> {
  const [balance, allocationPlan] = await Promise.all([
    getCreditBalance(shopId, prisma),
    planCreditAllocation(shopId, count, prisma),
  ]);

  return {
    estimatedCredits: count,
    enough: allocationPlan.enough,
    balance,
    allocation: mergeAllocationByType(allocationPlan.allocation),
  };
}

function mergeAllocationByType(
  allocation: readonly AllocationEntry[],
): Array<{ bucketType: string; amount: number }> {
  const map = new Map<string, number>();

  for (const entry of allocation) {
    const bucketType = isIncludedFamily(entry.bucketType)
      ? "MONTHLY_INCLUDED"
      : entry.bucketType;
    map.set(bucketType, (map.get(bucketType) ?? 0) + entry.amount);
  }

  const order: Record<string, number> = {
    MONTHLY_INCLUDED: 10,
    WELCOME: 20,
    OVERAGE_PACK: 30,
  };

  return Array.from(map.entries())
    .map(([bucketType, amount]) => ({ bucketType, amount }))
    .sort((left, right) => (order[left.bucketType] ?? 99) - (order[right.bucketType] ?? 99));
}

function creditDetailPayload(preflight: CreditPreflightResult) {
  return {
    estimatedCredits: preflight.estimatedCredits,
    enough: preflight.enough,
    includedRemaining: preflight.balance.includedRemaining,
    welcomeRemaining: preflight.balance.welcomeRemaining,
    overagePackRemaining: preflight.balance.overagePackRemaining,
    totalRemaining: preflight.balance.totalRemaining,
    allocation: preflight.allocation,
  };
}

function reservationPayload(reservation: CreditReservationWithLines) {
  return {
    id: reservation.id,
    status: reservation.status,
    requestedAmount: reservation.requestedAmount,
    reservedAmount: reservation.reservedAmount,
    expiresAt: reservation.expiresAt,
    allocation: reservation.lines.map((line: CreditReservationLine) => ({
      bucketId: line.bucketId,
      amount: line.reservedAmount,
    })),
  };
}

function validationResponse(error: StartValidationError): Response {
  return Response.json(
    {
      error: "VALIDATION_FAILED",
      code: error.code,
      message: error.message,
      candidateIds: error.candidateIds,
    },
    { status: 400 },
  );
}

function lockConflictResponse(lockType: string): Response {
  const message = lockType === "SCAN"
    ? "A scan is currently running. Please try again later."
    : "Another generation is already running. Please try again later.";

  return Response.json(
    {
      error: "LOCK_CONFLICT",
      lockType,
      message,
    },
    { status: 409 },
  );
}

async function rollbackGenerationStart(
  shopId: string,
  batchId: string | null,
  reservationId: string | null,
  lockAcquired: boolean,
): Promise<void> {
  if (lockAcquired && batchId) {
    try {
      await releaseGenerateLock(shopId, batchId);
    } catch (error) {
      logger.warn({ shopId, batchId, err: error }, "generation-start.rollback.lock-release-failed");
    }
  }

  if (reservationId) {
    try {
      await releaseReservation({
        shopId,
        reservationId,
        reason: "GENERATION_START_FAILED",
      });
    } catch (error) {
      logger.warn({ shopId, reservationId, err: error }, "generation-start.rollback.reservation-release-failed");
    }
  }

  if (batchId) {
    try {
      await prisma.generationBatch.delete({
        where: { id: batchId },
      });
    } catch (error) {
      logger.warn({ shopId, batchId, err: error }, "generation-start.rollback.batch-delete-failed");
      await prisma.generationBatch.updateMany({
        where: { id: batchId },
        data: { status: "FAILED" },
      });
    }
  }
}
