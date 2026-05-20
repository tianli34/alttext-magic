/**
 * File: server/modules/decorative/decorative-mark.server.ts
 * Purpose: 装饰性图片标记服务，在事务内联动 decorative_mark 与 alt_candidate.status。
 */
import {
  AltCandidateStatus,
  CandidateGroupType,
  type PrismaClient,
} from "@prisma/client";
import { normalizeScopeFlagState } from "../../../app/lib/scope-utils";
import prisma from "../../db/prisma.server";
import { computeEffectiveReadScopeFlags } from "../shop/scope.service";
import type { ScanScopeFlags } from "../shop/shop.types";
import {
  DecorativeActionError,
  type DecorativeCandidateSummary,
} from "./decorative.types";

interface DecorativeShopRow {
  scanScopeFlags: unknown;
  lastPublishedScopeFlags: unknown;
}

interface DecorativeCandidateRow {
  id: string;
  altTargetId: string;
  status: AltCandidateStatus;
  currentAltEmpty: boolean;
  hasDraft: boolean;
  updatedAt: Date;
  decorativeActive: boolean;
  groupTypes: CandidateGroupType[];
}

type DecorativeTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface DecorativeMarkDataAccess {
  getShop(shopId: string): Promise<DecorativeShopRow | null>;
  transaction<T>(
    callback: (tx: DecorativeTransactionClient) => Promise<T>,
  ): Promise<T>;
  getCandidateForUpdate(
    tx: DecorativeTransactionClient,
    shopId: string,
    altCandidateId: string,
  ): Promise<DecorativeCandidateRow | null>;
  upsertActiveMark(
    tx: DecorativeTransactionClient,
    input: { shopId: string; altTargetId: string; now: Date },
  ): Promise<void>;
  deactivateMark(
    tx: DecorativeTransactionClient,
    input: { shopId: string; altTargetId: string; now: Date },
  ): Promise<void>;
  updateCandidateStatus(
    tx: DecorativeTransactionClient,
    input: {
      shopId: string;
      altCandidateId: string;
      status: AltCandidateStatus;
    },
  ): Promise<DecorativeCandidateRow>;
}

const scopeFlagToGroupType: Record<keyof ScanScopeFlags, CandidateGroupType> = {
  PRODUCT_MEDIA: CandidateGroupType.PRODUCT_MEDIA,
  FILES: CandidateGroupType.FILES,
  COLLECTION_IMAGE: CandidateGroupType.COLLECTION,
  ARTICLE_IMAGE: CandidateGroupType.ARTICLE,
};

const markableStatuses = new Set<AltCandidateStatus>([
  AltCandidateStatus.MISSING,
  AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
  AltCandidateStatus.GENERATED,
  AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
]);

function mapScopeFlagsToGroupTypes(
  effectiveReadScopeFlags: ScanScopeFlags,
): CandidateGroupType[] {
  return Object.entries(scopeFlagToGroupType)
    .filter(([scopeFlag]) => effectiveReadScopeFlags[scopeFlag as keyof ScanScopeFlags])
    .map(([, groupType]) => groupType);
}

function restoreStatusAfterUnmark(
  candidate: Pick<DecorativeCandidateRow, "currentAltEmpty" | "hasDraft" | "status">,
): AltCandidateStatus {
  if (!candidate.currentAltEmpty) {
    return AltCandidateStatus.RESOLVED;
  }

  if (candidate.hasDraft) {
    return AltCandidateStatus.GENERATED;
  }

  if (candidate.status === AltCandidateStatus.GENERATION_FAILED_RETRYABLE) {
    return AltCandidateStatus.GENERATION_FAILED_RETRYABLE;
  }

  return AltCandidateStatus.MISSING;
}

function assertCandidateInScope(
  candidate: DecorativeCandidateRow,
  allowedGroups: readonly CandidateGroupType[],
): void {
  const inScope = candidate.groupTypes.some((groupType) =>
    allowedGroups.includes(groupType),
  );

  if (!inScope) {
    throw new DecorativeActionError(
      "OUT_OF_SCOPE",
      "Candidate is outside the current scope",
      403,
    );
  }
}

function assertCanMark(candidate: DecorativeCandidateRow): void {
  if (candidate.status === AltCandidateStatus.DECORATIVE_SKIPPED) {
    return;
  }

  if (!candidate.currentAltEmpty || !markableStatuses.has(candidate.status)) {
    throw new DecorativeActionError(
      "INVALID_STATUS",
      "Candidate status does not allow decorative mark",
      409,
    );
  }
}

function toSummary(candidate: DecorativeCandidateRow): DecorativeCandidateSummary {
  return {
    altCandidateId: candidate.id,
    altTargetId: candidate.altTargetId,
    status: candidate.status,
    decorativeActive: candidate.decorativeActive,
    currentAltEmpty: candidate.currentAltEmpty,
    groupTypes: candidate.groupTypes,
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

const prismaDecorativeMarkDataAccess: DecorativeMarkDataAccess = {
  async getShop(shopId) {
    return prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        scanScopeFlags: true,
        lastPublishedScopeFlags: true,
      },
    });
  },

  async transaction(callback) {
    return prisma.$transaction((tx) => callback(tx));
  },

  async getCandidateForUpdate(tx, shopId, altCandidateId) {
    const candidate = await tx.altCandidate.findFirst({
      where: {
        id: altCandidateId,
        shopId,
      },
      select: {
        id: true,
        altTargetId: true,
        status: true,
        updatedAt: true,
        altTarget: {
          select: {
            currentAltEmpty: true,
            decorativeMark: {
              select: { isActive: true },
            },
          },
        },
        groupProjections: {
          where: { shopId },
          select: { groupType: true },
        },
        draft: {
          select: { id: true },
        },
      },
    });

    if (!candidate) {
      return null;
    }

    return {
      id: candidate.id,
      altTargetId: candidate.altTargetId,
      status: candidate.status,
      currentAltEmpty: candidate.altTarget.currentAltEmpty,
      hasDraft: candidate.draft !== null,
      updatedAt: candidate.updatedAt,
      decorativeActive: candidate.altTarget.decorativeMark?.isActive ?? false,
      groupTypes: candidate.groupProjections.map((group) => group.groupType),
    };
  },

  async upsertActiveMark(tx, input) {
    await tx.decorativeMark.upsert({
      where: {
        shopId_altTargetId: {
          shopId: input.shopId,
          altTargetId: input.altTargetId,
        },
      },
      create: {
        shopId: input.shopId,
        altTargetId: input.altTargetId,
        isActive: true,
        markedAt: input.now,
        unmarkedAt: null,
      },
      update: {
        isActive: true,
        markedAt: input.now,
        unmarkedAt: null,
      },
      select: { id: true },
    });
  },

  async deactivateMark(tx, input) {
    await tx.decorativeMark.updateMany({
      where: {
        shopId: input.shopId,
        altTargetId: input.altTargetId,
        isActive: true,
      },
      data: {
        isActive: false,
        unmarkedAt: input.now,
      },
    });
  },

  async updateCandidateStatus(tx, input) {
    const candidate = await tx.altCandidate.update({
      where: {
        id: input.altCandidateId,
        shopId: input.shopId,
      },
      data: { status: input.status },
      select: {
        id: true,
        altTargetId: true,
        status: true,
        updatedAt: true,
        altTarget: {
          select: {
            currentAltEmpty: true,
            decorativeMark: {
              select: { isActive: true },
            },
          },
        },
        groupProjections: {
          where: { shopId: input.shopId },
          select: { groupType: true },
        },
        draft: {
          select: { id: true },
        },
      },
    });

    return {
      id: candidate.id,
      altTargetId: candidate.altTargetId,
      status: candidate.status,
      currentAltEmpty: candidate.altTarget.currentAltEmpty,
      hasDraft: candidate.draft !== null,
      updatedAt: candidate.updatedAt,
      decorativeActive: candidate.altTarget.decorativeMark?.isActive ?? false,
      groupTypes: candidate.groupProjections.map((group) => group.groupType),
    };
  },
};

async function getAllowedGroups(
  shopId: string,
  dataAccess: DecorativeMarkDataAccess,
): Promise<CandidateGroupType[]> {
  const shop = await dataAccess.getShop(shopId);

  if (!shop) {
    throw new DecorativeActionError("NOT_FOUND", "Shop not found", 404);
  }

  const scanScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );

  return mapScopeFlagsToGroupTypes(effectiveReadScopeFlags);
}

export async function markDecorativeCandidate(
  shopId: string,
  altCandidateId: string,
  dataAccess: DecorativeMarkDataAccess = prismaDecorativeMarkDataAccess,
): Promise<DecorativeCandidateSummary> {
  const allowedGroups = await getAllowedGroups(shopId, dataAccess);

  return dataAccess.transaction(async (tx) => {
    const candidate = await dataAccess.getCandidateForUpdate(
      tx,
      shopId,
      altCandidateId,
    );

    if (!candidate) {
      throw new DecorativeActionError("NOT_FOUND", "Candidate not found", 404);
    }

    assertCandidateInScope(candidate, allowedGroups);
    assertCanMark(candidate);

    await dataAccess.upsertActiveMark(tx, {
      shopId,
      altTargetId: candidate.altTargetId,
      now: new Date(),
    });

    const updatedCandidate = await dataAccess.updateCandidateStatus(tx, {
      shopId,
      altCandidateId,
      status: AltCandidateStatus.DECORATIVE_SKIPPED,
    });

    return toSummary({
      ...updatedCandidate,
      decorativeActive: true,
    });
  });
}

export async function unmarkDecorativeCandidate(
  shopId: string,
  altCandidateId: string,
  dataAccess: DecorativeMarkDataAccess = prismaDecorativeMarkDataAccess,
): Promise<DecorativeCandidateSummary> {
  const allowedGroups = await getAllowedGroups(shopId, dataAccess);

  return dataAccess.transaction(async (tx) => {
    const candidate = await dataAccess.getCandidateForUpdate(
      tx,
      shopId,
      altCandidateId,
    );

    if (!candidate) {
      throw new DecorativeActionError("NOT_FOUND", "Candidate not found", 404);
    }

    assertCandidateInScope(candidate, allowedGroups);

    await dataAccess.deactivateMark(tx, {
      shopId,
      altTargetId: candidate.altTargetId,
      now: new Date(),
    });

    if (!candidate.decorativeActive && candidate.status !== AltCandidateStatus.DECORATIVE_SKIPPED) {
      return toSummary(candidate);
    }

    const updatedCandidate = await dataAccess.updateCandidateStatus(tx, {
      shopId,
      altCandidateId,
      status: restoreStatusAfterUnmark(candidate),
    });

    return toSummary({
      ...updatedCandidate,
      decorativeActive: false,
    });
  });
}
