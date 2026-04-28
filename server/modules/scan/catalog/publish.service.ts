/**
 * File: server/modules/scan/catalog/publish.service.ts
 * Purpose: 将 `scan_result_*` 原子发布到正式表，仅替换成功资源类型对应切片。
 */
import {
  AltCandidateMissingReason,
  AltCandidateStatus,
  AltPlane,
  CandidateGroupPrimaryUsageType,
  CandidateGroupType,
  ImageUsageType,
  PresentStatus,
  Prisma,
  ScanJobStatus,
  ScanResourceType,
} from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "publish-service" });

const DEFAULT_LOCALE = "default";
const FILE_ALT_RESOURCE_TYPES = new Set<ScanResourceType>([
  "PRODUCT_MEDIA",
  "FILES",
]);
const SUCCESSFUL_STATUSES = new Set<ScanJobStatus>([
  "SUCCESS",
  "PARTIAL_SUCCESS",
]);
const ALL_SCAN_RESOURCE_TYPES: ScanResourceType[] = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
];

interface PublishScanJobRow {
  id: string;
  shopId: string;
  status: ScanJobStatus;
  publishStatus: "PENDING" | "PUBLISHED" | "NOT_PUBLISHED";
  scopeFlags: Prisma.JsonValue;
  successfulResourceTypes: Prisma.JsonValue;
}

interface ResultTargetRow {
  shopId: string;
  scanJobId: string;
  resourceType: ScanResourceType;
  altPlane: AltPlane;
  writeTargetId: string;
  locale: string;
  displayTitle: string | null;
  displayHandle: string | null;
  previewUrl: string | null;
  currentAltText: string | null;
  currentAltEmpty: boolean;
}

interface ResultUsageRow {
  shopId: string;
  scanJobId: string;
  resourceType: ScanResourceType;
  altPlane: AltPlane;
  writeTargetId: string;
  locale: string;
  usageType: ImageUsageType;
  usageId: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
}

interface ImpactedTargetSummary {
  id: string;
  altPlane: AltPlane;
  writeTargetId: string;
  displayTitle: string | null;
  displayHandle: string | null;
  currentAltEmpty: boolean;
  presentStatus: PresentStatus;
  decorativeMark: { isActive: boolean } | null;
  altCandidate: {
    id: string;
    status: AltCandidateStatus;
    draft: { expiresAt: Date } | null;
  } | null;
}

interface PublishTransactionCounts {
  publishedTargetCount: number;
  publishedUsageCount: number;
  candidateCount: number;
  projectionCount: number;
}

export interface PublishExecutionResult extends PublishTransactionCounts {
  skipped: boolean;
  reason?:
    | "SCAN_JOB_NOT_FOUND"
    | "SHOP_MISMATCH"
    | "SCAN_JOB_NOT_TERMINAL"
    | "NO_SUCCESSFUL_RESOURCE_TYPES"
    | "ALREADY_PUBLISHED";
}

export interface PublishScanResultInput {
  shopId: string;
  scanJobId: string;
}

export async function publishScanResult(
  input: PublishScanResultInput,
): Promise<PublishExecutionResult> {
  const scanJob = await prisma.scanJob.findUnique({
    where: { id: input.scanJobId },
    select: {
      id: true,
      shopId: true,
      status: true,
      publishStatus: true,
      scopeFlags: true,
      successfulResourceTypes: true,
    },
  });

  if (!scanJob) {
    return skippedResult("SCAN_JOB_NOT_FOUND");
  }

  if (scanJob.shopId !== input.shopId) {
    return skippedResult("SHOP_MISMATCH");
  }

  if (!SUCCESSFUL_STATUSES.has(scanJob.status)) {
    if (scanJob.status === "FAILED" && scanJob.publishStatus !== "NOT_PUBLISHED") {
      await prisma.scanJob.update({
        where: { id: scanJob.id },
        data: { publishStatus: "NOT_PUBLISHED" },
      });
    }

    return skippedResult("SCAN_JOB_NOT_TERMINAL");
  }

  if (scanJob.publishStatus === "PUBLISHED") {
    return skippedResult("ALREADY_PUBLISHED");
  }

  const successfulResourceTypes = parseSuccessfulResourceTypes(
    scanJob.successfulResourceTypes,
  );

  if (successfulResourceTypes.length === 0) {
    await prisma.scanJob.update({
      where: { id: scanJob.id },
      data: { publishStatus: "NOT_PUBLISHED" },
    });

    return skippedResult("NO_SUCCESSFUL_RESOURCE_TYPES");
  }

  const [resultTargets, resultUsages] = await Promise.all([
    prisma.scanResultTarget.findMany({
      where: {
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
      },
      select: {
        shopId: true,
        scanJobId: true,
        resourceType: true,
        altPlane: true,
        writeTargetId: true,
        locale: true,
        displayTitle: true,
        displayHandle: true,
        previewUrl: true,
        currentAltText: true,
        currentAltEmpty: true,
      },
    }),
    prisma.scanResultUsage.findMany({
      where: {
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
        resourceType: { in: successfulResourceTypes },
      },
      select: {
        shopId: true,
        scanJobId: true,
        resourceType: true,
        altPlane: true,
        writeTargetId: true,
        locale: true,
        usageType: true,
        usageId: true,
        title: true,
        handle: true,
        positionIndex: true,
      },
    }),
  ]);

  const resultTargetMap = new Map<string, ResultTargetRow>();
  for (const target of resultTargets) {
    resultTargetMap.set(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale), target);
  }

  const now = new Date();

  const counts = await prisma.$transaction(async (tx) => {
    const impactedTargetIds = new Set<string>();
    let publishedTargetCount = 0;
    let publishedUsageCount = 0;

    const successfulSet = new Set(successfulResourceTypes);

    const fileUsageRows = resultUsages.filter((usage) =>
      FILE_ALT_RESOURCE_TYPES.has(usage.resourceType),
    );
    const fileWriteTargetIds = new Set(
      fileUsageRows
        .filter((usage) => successfulSet.has(usage.resourceType))
        .map((usage) => usage.writeTargetId),
    );

    if (fileWriteTargetIds.size > 0) {
      const fileTargetsToPublish = dedupeTargets(
        [...fileWriteTargetIds]
          .map((writeTargetId) =>
            resultTargetMap.get(
              buildTargetSliceKey("FILE_ALT", writeTargetId, DEFAULT_LOCALE),
            ),
          )
          .filter(isNonNull),
      );

      const altTargetIdByWriteTargetId = new Map<string, string>();

      for (const target of fileTargetsToPublish) {
        const publishedTarget = await upsertPublishedTarget(tx, {
          ...target,
          lastPublishedScanJobId: scanJob.id,
          lastSeenAt: now,
          presentStatus: "PRESENT",
        });
        altTargetIdByWriteTargetId.set(target.writeTargetId, publishedTarget.id);
        impactedTargetIds.add(publishedTarget.id);
        publishedTargetCount += 1;
      }

      for (const usage of fileUsageRows.filter((row) => successfulSet.has(row.resourceType))) {
        const altTargetId = altTargetIdByWriteTargetId.get(usage.writeTargetId);
        if (!altTargetId) {
          continue;
        }

        await upsertPublishedUsage(tx, {
          ...usage,
          altTargetId,
          lastPublishedScanJobId: scanJob.id,
          lastSeenAt: now,
          lastSeenScanJobId: scanJob.id,
          presentStatus: "PRESENT",
        });
        publishedUsageCount += 1;
      }

      if (successfulSet.has("PRODUCT_MEDIA")) {
        const sweptTargetIds = await sweepUsageSlice(tx, {
          shopId: scanJob.shopId,
          usageType: "PRODUCT",
          currentUsageKeys: new Set(
            fileUsageRows
              .filter((usage) => usage.resourceType === "PRODUCT_MEDIA")
              .map((usage) => {
                const altTargetId = altTargetIdByWriteTargetId.get(usage.writeTargetId);
                return altTargetId ? buildUsageSliceKey(altTargetId, usage.usageType, usage.usageId) : null;
              })
              .filter(isNonNull),
          ),
          scanJobId: scanJob.id,
        });
        sweptTargetIds.forEach((targetId) => impactedTargetIds.add(targetId));
      }

      if (successfulSet.has("FILES")) {
        const sweptTargetIds = await sweepUsageSlice(tx, {
          shopId: scanJob.shopId,
          usageType: "FILE",
          currentUsageKeys: new Set(
            fileUsageRows
              .filter((usage) => usage.resourceType === "FILES")
              .map((usage) => {
                const altTargetId = altTargetIdByWriteTargetId.get(usage.writeTargetId);
                return altTargetId ? buildUsageSliceKey(altTargetId, usage.usageType, usage.usageId) : null;
              })
              .filter(isNonNull),
          ),
          scanJobId: scanJob.id,
        });
        sweptTargetIds.forEach((targetId) => impactedTargetIds.add(targetId));
      }

      await recomputeFileAltPresentStatus(tx, {
        scanJobId: scanJob.id,
        targetIds: [...impactedTargetIds],
      });
    }

    if (successfulSet.has("COLLECTION_IMAGE")) {
      const impacted = await publishSingleTargetSlice(tx, {
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
        altPlane: "COLLECTION_IMAGE_ALT",
        resultTargets: resultTargets.filter(
          (target) => target.resourceType === "COLLECTION_IMAGE",
        ),
        now,
      });
      impacted.forEach((targetId) => impactedTargetIds.add(targetId));
      publishedTargetCount += impacted.length;
    }

    if (successfulSet.has("ARTICLE_IMAGE")) {
      const impacted = await publishSingleTargetSlice(tx, {
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
        altPlane: "ARTICLE_IMAGE_ALT",
        resultTargets: resultTargets.filter(
          (target) => target.resourceType === "ARTICLE_IMAGE",
        ),
        now,
      });
      impacted.forEach((targetId) => impactedTargetIds.add(targetId));
      publishedTargetCount += impacted.length;
    }

    const impactedTargets = impactedTargetIds.size
      ? await tx.altTarget.findMany({
          where: {
            id: { in: [...impactedTargetIds] },
          },
          select: {
            id: true,
            altPlane: true,
            writeTargetId: true,
            displayTitle: true,
            displayHandle: true,
            currentAltEmpty: true,
            presentStatus: true,
            decorativeMark: {
              select: {
                isActive: true,
              },
            },
            altCandidate: {
              select: {
                id: true,
                status: true,
                draft: {
                  select: {
                    expiresAt: true,
                  },
                },
              },
            },
          },
        })
      : [];

    const candidateByTargetId = new Map<string, string>();
    let candidateCount = 0;

    for (const target of impactedTargets) {
      const nextCandidate = computeNextCandidateState({
        target,
        now,
      });
      const candidate = await tx.altCandidate.upsert({
        where: {
          altTargetId: target.id,
        },
        create: {
          shopId: scanJob.shopId,
          altTargetId: target.id,
          status: nextCandidate.status,
          missingReason: nextCandidate.missingReason,
          riskFlags: [],
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenScanJobId: scanJob.id,
        },
        update: {
          status: nextCandidate.status,
          missingReason: nextCandidate.missingReason,
          lastSeenAt: now,
          lastSeenScanJobId: scanJob.id,
        },
        select: {
          id: true,
        },
      });
      candidateByTargetId.set(target.id, candidate.id);
      candidateCount += 1;
    }

    const presentUsages = impactedTargetIds.size
      ? await tx.imageUsage.findMany({
          where: {
            altTargetId: { in: [...impactedTargetIds] },
            presentStatus: "PRESENT",
          },
          select: {
            altTargetId: true,
            usageType: true,
            usageId: true,
            title: true,
            handle: true,
            positionIndex: true,
          },
          orderBy: [{ usageType: "asc" }, { positionIndex: "asc" }, { usageId: "asc" }],
        })
      : [];

    const usagesByTargetId = groupPresentUsagesByTargetId(presentUsages);
    let projectionCount = 0;

    for (const target of impactedTargets) {
      const altCandidateId = candidateByTargetId.get(target.id);
      if (!altCandidateId) {
        continue;
      }

      projectionCount += await rebuildTargetProjections(tx, {
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
        target,
        altCandidateId,
        presentUsages: usagesByTargetId.get(target.id) ?? [],
      });
    }

    await tx.shop.update({
      where: { id: scanJob.shopId },
      data: {
        lastPublishedScanJobId: scanJob.id,
        lastPublishedAt: now,
        lastPublishedScopeFlags: normalizeJsonForPrisma(scanJob.scopeFlags),
      },
    });

    await tx.scanJob.update({
      where: { id: scanJob.id },
      data: {
        publishStatus: "PUBLISHED",
        publishedAt: now,
      },
    });

    return {
      publishedTargetCount,
      publishedUsageCount,
      candidateCount,
      projectionCount,
    };
  });

  logger.info(
    {
      shopId: input.shopId,
      scanJobId: input.scanJobId,
      successfulResourceTypes,
      ...counts,
    },
    "publish-scan.success",
  );

  return {
    skipped: false,
    ...counts,
  };
}

function skippedResult(reason: NonNullable<PublishExecutionResult["reason"]>): PublishExecutionResult {
  return {
    skipped: true,
    reason,
    publishedTargetCount: 0,
    publishedUsageCount: 0,
    candidateCount: 0,
    projectionCount: 0,
  };
}

function parseSuccessfulResourceTypes(value: Prisma.JsonValue): ScanResourceType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is ScanResourceType => {
    return (
      typeof item === "string" &&
      ALL_SCAN_RESOURCE_TYPES.includes(item as ScanResourceType)
    );
  });
}

function dedupeTargets(targets: ResultTargetRow[]): ResultTargetRow[] {
  const result = new Map<string, ResultTargetRow>();

  for (const target of targets) {
    result.set(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale), target);
  }

  return [...result.values()];
}

function buildTargetSliceKey(
  altPlane: AltPlane,
  writeTargetId: string,
  locale: string,
): string {
  return [altPlane, writeTargetId, locale].join("::");
}

function buildUsageSliceKey(
  altTargetId: string,
  usageType: ImageUsageType,
  usageId: string,
): string {
  return [altTargetId, usageType, usageId].join("::");
}

async function upsertPublishedTarget(
  tx: Prisma.TransactionClient,
  input: ResultTargetRow & {
    lastPublishedScanJobId: string;
    lastSeenAt: Date;
    presentStatus: PresentStatus;
  },
) {
  return tx.altTarget.upsert({
    where: {
      shopId_altPlane_writeTargetId_locale: {
        shopId: input.shopId,
        altPlane: input.altPlane,
        writeTargetId: input.writeTargetId,
        locale: input.locale,
      },
    },
    create: {
      shopId: input.shopId,
      altPlane: input.altPlane,
      writeTargetId: input.writeTargetId,
      locale: input.locale,
      displayTitle: input.displayTitle,
      displayHandle: input.displayHandle,
      previewUrl: input.previewUrl,
      currentAltText: input.currentAltText,
      currentAltEmpty: input.currentAltEmpty,
      lastPublishedScanJobId: input.lastPublishedScanJobId,
      lastSeenAt: input.lastSeenAt,
      presentStatus: input.presentStatus,
    },
    update: {
      displayTitle: input.displayTitle,
      displayHandle: input.displayHandle,
      previewUrl: input.previewUrl,
      currentAltText: input.currentAltText,
      currentAltEmpty: input.currentAltEmpty,
      lastPublishedScanJobId: input.lastPublishedScanJobId,
      lastSeenAt: input.lastSeenAt,
      presentStatus: input.presentStatus,
    },
    select: {
      id: true,
    },
  });
}

async function upsertPublishedUsage(
  tx: Prisma.TransactionClient,
  input: ResultUsageRow & {
    altTargetId: string;
    lastPublishedScanJobId: string;
    lastSeenAt: Date;
    lastSeenScanJobId: string;
    presentStatus: PresentStatus;
  },
): Promise<void> {
  await tx.imageUsage.upsert({
    where: {
      shopId_altTargetId_usageType_usageId: {
        shopId: input.shopId,
        altTargetId: input.altTargetId,
        usageType: input.usageType,
        usageId: input.usageId,
      },
    },
    create: {
      shopId: input.shopId,
      altTargetId: input.altTargetId,
      usageType: input.usageType,
      usageId: input.usageId,
      title: input.title,
      handle: input.handle,
      positionIndex: input.positionIndex,
      lastPublishedScanJobId: input.lastPublishedScanJobId,
      lastSeenAt: input.lastSeenAt,
      lastSeenScanJobId: input.lastSeenScanJobId,
      presentStatus: input.presentStatus,
    },
    update: {
      title: input.title,
      handle: input.handle,
      positionIndex: input.positionIndex,
      lastPublishedScanJobId: input.lastPublishedScanJobId,
      lastSeenAt: input.lastSeenAt,
      lastSeenScanJobId: input.lastSeenScanJobId,
      presentStatus: input.presentStatus,
    },
  });
}

async function sweepUsageSlice(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    usageType: ImageUsageType;
    currentUsageKeys: Set<string>;
    scanJobId: string;
  },
): Promise<string[]> {
  const existing = await tx.imageUsage.findMany({
    where: {
      shopId: input.shopId,
      usageType: input.usageType,
    },
    select: {
      id: true,
      altTargetId: true,
      usageType: true,
      usageId: true,
    },
  });

  const absentRows = existing.filter(
    (row) => !input.currentUsageKeys.has(buildUsageSliceKey(row.altTargetId, row.usageType, row.usageId)),
  );

  if (absentRows.length === 0) {
    return [];
  }

  await tx.imageUsage.updateMany({
    where: {
      id: { in: absentRows.map((row) => row.id) },
    },
    data: {
      presentStatus: "NOT_FOUND",
      lastPublishedScanJobId: input.scanJobId,
    },
  });

  return [...new Set(absentRows.map((row) => row.altTargetId))];
}

async function recomputeFileAltPresentStatus(
  tx: Prisma.TransactionClient,
  input: {
    scanJobId: string;
    targetIds: string[];
  },
): Promise<void> {
  if (input.targetIds.length === 0) {
    return;
  }

  const usages = await tx.imageUsage.findMany({
    where: {
      altTargetId: { in: input.targetIds },
      usageType: { in: ["PRODUCT", "FILE"] },
    },
    select: {
      altTargetId: true,
      presentStatus: true,
    },
  });

  const hasPresentByTargetId = new Map<string, boolean>();
  for (const usage of usages) {
    if (usage.presentStatus === "PRESENT") {
      hasPresentByTargetId.set(usage.altTargetId, true);
    } else if (!hasPresentByTargetId.has(usage.altTargetId)) {
      hasPresentByTargetId.set(usage.altTargetId, false);
    }
  }

  for (const targetId of input.targetIds) {
    await tx.altTarget.update({
      where: { id: targetId },
      data: {
        presentStatus: resolveFileAltPresentStatus(
          hasPresentByTargetId.get(targetId) ? ["PRESENT"] : ["NOT_FOUND"],
        ),
        lastPublishedScanJobId: input.scanJobId,
      },
    });
  }
}

async function publishSingleTargetSlice(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    scanJobId: string;
    altPlane: AltPlane;
    resultTargets: ResultTargetRow[];
    now: Date;
  },
): Promise<string[]> {
  const impactedTargetIds = new Set<string>();
  const currentKeys = new Set<string>();

  for (const target of input.resultTargets) {
    const publishedTarget = await upsertPublishedTarget(tx, {
      ...target,
      lastPublishedScanJobId: input.scanJobId,
      lastSeenAt: input.now,
      presentStatus: "PRESENT",
    });
    impactedTargetIds.add(publishedTarget.id);
    currentKeys.add(
      buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale),
    );
  }

  const existingTargets = await tx.altTarget.findMany({
    where: {
      shopId: input.shopId,
      altPlane: input.altPlane,
    },
    select: {
      id: true,
      altPlane: true,
      writeTargetId: true,
      locale: true,
    },
  });

  const absentIds = existingTargets
    .filter(
      (target) =>
        !currentKeys.has(
          buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale),
        ),
    )
    .map((target) => target.id);

  if (absentIds.length > 0) {
    await tx.altTarget.updateMany({
      where: {
        id: { in: absentIds },
      },
      data: {
        presentStatus: "NOT_FOUND",
        lastPublishedScanJobId: input.scanJobId,
      },
    });
    absentIds.forEach((targetId) => impactedTargetIds.add(targetId));
  }

  return [...impactedTargetIds];
}

export function computeNextCandidateState(input: {
  target: ImpactedTargetSummary;
  now: Date;
}): {
  status: AltCandidateStatus;
  missingReason: AltCandidateMissingReason | null;
} {
  if (input.target.presentStatus === "NOT_FOUND") {
    return {
      status: "NOT_FOUND",
      missingReason: null,
    };
  }

  if (!input.target.currentAltEmpty) {
    return {
      status: "RESOLVED",
      missingReason: null,
    };
  }

  if (input.target.decorativeMark?.isActive) {
    return {
      status: "DECORATIVE_SKIPPED",
      missingReason: null,
    };
  }

  const hasActiveDraft =
    input.target.altCandidate?.draft !== null &&
    input.target.altCandidate?.draft !== undefined &&
    input.target.altCandidate.draft.expiresAt.getTime() > input.now.getTime();

  if (hasActiveDraft) {
    return {
      status:
        input.target.altCandidate?.status === "WRITEBACK_FAILED_RETRYABLE"
          ? "WRITEBACK_FAILED_RETRYABLE"
          : "GENERATED",
      missingReason: null,
    };
  }

  return {
    status:
      input.target.altCandidate?.status === "GENERATION_FAILED_RETRYABLE"
        ? "GENERATION_FAILED_RETRYABLE"
        : "MISSING",
    missingReason: "EMPTY",
  };
}

export function resolveFileAltPresentStatus(
  presentStatuses: PresentStatus[],
): PresentStatus {
  return presentStatuses.includes("PRESENT") ? "PRESENT" : "NOT_FOUND";
}

function groupPresentUsagesByTargetId(
  usages: Array<{
    altTargetId: string;
    usageType: ImageUsageType;
    usageId: string;
    title: string | null;
    handle: string | null;
    positionIndex: number | null;
  }>,
) {
  const result = new Map<
    string,
    Array<{
      usageType: ImageUsageType;
      usageId: string;
      title: string | null;
      handle: string | null;
      positionIndex: number | null;
    }>
  >();

  for (const usage of usages) {
    const bucket = result.get(usage.altTargetId);
    const entry = {
      usageType: usage.usageType,
      usageId: usage.usageId,
      title: usage.title,
      handle: usage.handle,
      positionIndex: usage.positionIndex,
    };

    if (bucket) {
      bucket.push(entry);
    } else {
      result.set(usage.altTargetId, [entry]);
    }
  }

  return result;
}

async function rebuildTargetProjections(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    scanJobId: string;
    target: ImpactedTargetSummary;
    altCandidateId: string;
    presentUsages: Array<{
      usageType: ImageUsageType;
      usageId: string;
      title: string | null;
      handle: string | null;
      positionIndex: number | null;
    }>;
  },
): Promise<number> {
  const totalUsageCount = input.presentUsages.length;

  if (input.target.altPlane === "FILE_ALT") {
    const productUsages = input.presentUsages
      .filter((usage) => usage.usageType === "PRODUCT")
      .sort(compareProductUsage);
    const fileUsages = input.presentUsages
      .filter((usage) => usage.usageType === "FILE")
      .sort((left, right) => left.usageId.localeCompare(right.usageId));
    let upsertCount = 0;

    if (productUsages.length > 0) {
      const primary = productUsages[0];
      await upsertGroupProjection(tx, {
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        groupType: "PRODUCT_MEDIA",
        altCandidateId: input.altCandidateId,
        altTargetId: input.target.id,
        primaryUsageType: "PRODUCT",
        primaryUsageId: primary?.usageId ?? input.target.writeTargetId,
        primaryTitle: primary?.title ?? input.target.displayTitle,
        primaryHandle: primary?.handle ?? input.target.displayHandle,
        primaryPositionIndex: primary?.positionIndex ?? null,
        additionalUsageCount: productUsages.length - 1,
        usageCountPresent: totalUsageCount,
        impactScopeSummary: {
          productUsageCountPresent: productUsages.length,
          fileUsageCountPresent: fileUsages.length,
        },
      });
      upsertCount += 1;
    } else {
      await deleteGroupProjection(tx, input.shopId, input.altCandidateId, "PRODUCT_MEDIA");
    }

    if (fileUsages.length > 0) {
      const primary = fileUsages[0];
      await upsertGroupProjection(tx, {
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        groupType: "FILES",
        altCandidateId: input.altCandidateId,
        altTargetId: input.target.id,
        primaryUsageType: "FILE",
        primaryUsageId: primary?.usageId ?? input.target.writeTargetId,
        primaryTitle: primary?.title ?? input.target.displayTitle,
        primaryHandle: primary?.handle ?? input.target.displayHandle,
        primaryPositionIndex: null,
        additionalUsageCount: fileUsages.length - 1,
        usageCountPresent: totalUsageCount,
        impactScopeSummary: {
          productUsageCountPresent: productUsages.length,
          fileUsageCountPresent: fileUsages.length,
        },
      });
      upsertCount += 1;
    } else {
      await deleteGroupProjection(tx, input.shopId, input.altCandidateId, "FILES");
    }

    return upsertCount;
  }

  if (input.target.altPlane === "COLLECTION_IMAGE_ALT") {
    if (input.target.presentStatus === "PRESENT") {
      await upsertGroupProjection(tx, {
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        groupType: "COLLECTION",
        altCandidateId: input.altCandidateId,
        altTargetId: input.target.id,
        primaryUsageType: "SELF",
        primaryUsageId: input.target.writeTargetId,
        primaryTitle: input.target.displayTitle,
        primaryHandle: input.target.displayHandle,
        primaryPositionIndex: null,
        additionalUsageCount: 0,
        usageCountPresent: 1,
        impactScopeSummary: {},
      });
      return 1;
    }

    await deleteGroupProjection(tx, input.shopId, input.altCandidateId, "COLLECTION");
    return 0;
  }

  if (input.target.presentStatus === "PRESENT") {
    await upsertGroupProjection(tx, {
      shopId: input.shopId,
      scanJobId: input.scanJobId,
      groupType: "ARTICLE",
      altCandidateId: input.altCandidateId,
      altTargetId: input.target.id,
      primaryUsageType: "SELF",
      primaryUsageId: input.target.writeTargetId,
      primaryTitle: input.target.displayTitle,
      primaryHandle: input.target.displayHandle,
      primaryPositionIndex: null,
      additionalUsageCount: 0,
      usageCountPresent: 1,
      impactScopeSummary: {},
    });
    return 1;
  }

  await deleteGroupProjection(tx, input.shopId, input.altCandidateId, "ARTICLE");
  return 0;
}

function compareProductUsage(
  left: { positionIndex: number | null; usageId: string },
  right: { positionIndex: number | null; usageId: string },
): number {
  if (left.positionIndex === null && right.positionIndex === null) {
    return left.usageId.localeCompare(right.usageId);
  }

  if (left.positionIndex === null) {
    return 1;
  }

  if (right.positionIndex === null) {
    return -1;
  }

  if (left.positionIndex !== right.positionIndex) {
    return left.positionIndex - right.positionIndex;
  }

  return left.usageId.localeCompare(right.usageId);
}

async function upsertGroupProjection(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    scanJobId: string;
    groupType: CandidateGroupType;
    altCandidateId: string;
    altTargetId: string;
    primaryUsageType: CandidateGroupPrimaryUsageType;
    primaryUsageId: string;
    primaryTitle: string | null;
    primaryHandle: string | null;
    primaryPositionIndex: number | null;
    additionalUsageCount: number;
    usageCountPresent: number;
    impactScopeSummary: Prisma.JsonObject;
  },
): Promise<void> {
  await tx.candidateGroupProjection.upsert({
    where: {
      shopId_groupType_altCandidateId: {
        shopId: input.shopId,
        groupType: input.groupType,
        altCandidateId: input.altCandidateId,
      },
    },
    create: {
      shopId: input.shopId,
      groupType: input.groupType,
      altCandidateId: input.altCandidateId,
      altTargetId: input.altTargetId,
      primaryUsageType: input.primaryUsageType,
      primaryUsageId: input.primaryUsageId,
      primaryTitle: input.primaryTitle,
      primaryHandle: input.primaryHandle,
      primaryPositionIndex: input.primaryPositionIndex,
      additionalUsageCount: input.additionalUsageCount,
      usageCountPresent: input.usageCountPresent,
      impactScopeSummary: input.impactScopeSummary,
      lastPublishedScanJobId: input.scanJobId,
    },
    update: {
      altTargetId: input.altTargetId,
      primaryUsageType: input.primaryUsageType,
      primaryUsageId: input.primaryUsageId,
      primaryTitle: input.primaryTitle,
      primaryHandle: input.primaryHandle,
      primaryPositionIndex: input.primaryPositionIndex,
      additionalUsageCount: input.additionalUsageCount,
      usageCountPresent: input.usageCountPresent,
      impactScopeSummary: input.impactScopeSummary,
      lastPublishedScanJobId: input.scanJobId,
    },
  });
}

async function deleteGroupProjection(
  tx: Prisma.TransactionClient,
  shopId: string,
  altCandidateId: string,
  groupType: CandidateGroupType,
): Promise<void> {
  await tx.candidateGroupProjection.deleteMany({
    where: {
      shopId,
      altCandidateId,
      groupType,
    },
  });
}

function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function normalizeJsonForPrisma(
  value: Prisma.JsonValue,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}
