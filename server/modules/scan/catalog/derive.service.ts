/**
 * File: server/modules/scan/catalog/derive.service.ts
 * Purpose: 将 staging attempt 推导为待发布结果层 `scan_result_target` / `scan_result_usage`。
 *
 * 设计要点:
 * - derive 只消费单个成功 attempt 的 staging 数据
 * - `FILE_ALT` 需要在 `PRODUCT_MEDIA` / `FILES` 间共享 target，但 usage 需分别保留
 * - 通过唯一键 upsert 保证重复执行稳定
 * - 若同一 `FILE_ALT` 出现字段冲突，记录告警并按“非空优先、当前写入胜出”合并
 */
import type {
  AltPlane,
  ImageUsageType,
  Prisma,
  ScanResourceType,
  ScanTaskAttemptStatus,
  ScanTaskStatus,
} from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "derive-service" });

const DEFAULT_LOCALE = "default";
const FILE_ALT_RESOURCE_TYPES = ["PRODUCT_MEDIA", "FILES"] as const;
type FileAltResourceType = (typeof FILE_ALT_RESOURCE_TYPES)[number];

interface AttemptContext {
  id: string;
  shopId: string;
  scanTaskId: string;
  attemptNo: number;
  status: ScanTaskAttemptStatus;
  scanTask: {
    id: string;
    shopId: string;
    scanJobId: string;
    resourceType: ScanResourceType;
    currentAttemptNo: number;
    status: ScanTaskStatus;
    successfulAttemptId: string | null;
  };
}

interface ExistingFileAltTarget {
  resourceType: ScanResourceType;
  writeTargetId: string;
  currentAltText: string | null;
  previewUrl: string | null;
  displayTitle: string | null;
  displayHandle: string | null;
}

interface FileTargetDraft {
  writeTargetId: string;
  previewUrl: string | null;
  currentAltText: string | null;
  displayTitle: string | null;
  displayHandle: string | null;
}

interface DerivedTargetRecord {
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

interface DerivedUsageRecord {
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

export interface DeriveWarning {
  code: "FILE_ALT_FIELD_CONFLICT";
  writeTargetId: string;
  field: "currentAltText" | "previewUrl";
  existingValue: string;
  incomingValue: string;
  existingResourceType: ScanResourceType;
  incomingResourceType: ScanResourceType;
}

export interface DeriveComputationResult {
  targets: DerivedTargetRecord[];
  usages: DerivedUsageRecord[];
  warnings: DeriveWarning[];
}

interface ProductStagingRow {
  productId: string;
  title: string;
  handle: string;
}

interface ProductMediaStagingRow {
  mediaImageId: string;
  parentProductId: string;
  alt: string | null;
  url: string;
  positionIndex: number | null;
}

interface FileStagingRow {
  mediaImageId: string;
  alt: string | null;
  url: string;
}

interface CollectionStagingRow {
  collectionId: string;
  title: string;
  handle: string;
  imageAltText: string | null;
  imageUrl: string | null;
}

interface ArticleStagingRow {
  articleId: string;
  title: string;
  handle: string;
  imageAltText: string | null;
  imageUrl: string | null;
}

interface DerivePersistence {
  findAttemptContext(scanTaskAttemptId: string): Promise<AttemptContext | null>;
  loadProductStaging(scanTaskAttemptId: string): Promise<ProductStagingRow[]>;
  loadProductMediaStaging(scanTaskAttemptId: string): Promise<ProductMediaStagingRow[]>;
  loadFileStaging(scanTaskAttemptId: string): Promise<FileStagingRow[]>;
  loadCollectionStaging(scanTaskAttemptId: string): Promise<CollectionStagingRow[]>;
  loadArticleStaging(scanTaskAttemptId: string): Promise<ArticleStagingRow[]>;
  loadExistingFileAltTargets(input: {
    shopId: string;
    scanJobId: string;
    writeTargetIds: string[];
  }): Promise<ExistingFileAltTarget[]>;
  persistDerivedResults(result: DeriveComputationResult): Promise<void>;
}

const defaultPersistence: DerivePersistence = {
  async findAttemptContext(scanTaskAttemptId) {
    return prisma.scanTaskAttempt.findUnique({
      where: { id: scanTaskAttemptId },
      select: {
        id: true,
        shopId: true,
        scanTaskId: true,
        attemptNo: true,
        status: true,
        scanTask: {
          select: {
            id: true,
            shopId: true,
            scanJobId: true,
            resourceType: true,
            currentAttemptNo: true,
            status: true,
            successfulAttemptId: true,
          },
        },
      },
    });
  },
  async loadProductStaging(scanTaskAttemptId) {
    return prisma.stgProduct.findMany({
      where: { scanTaskAttemptId },
      select: {
        productId: true,
        title: true,
        handle: true,
      },
    });
  },
  async loadProductMediaStaging(scanTaskAttemptId) {
    return prisma.stgMediaImageProduct.findMany({
      where: { scanTaskAttemptId },
      select: {
        mediaImageId: true,
        parentProductId: true,
        alt: true,
        url: true,
        positionIndex: true,
      },
      orderBy: [
        { parentProductId: "asc" },
        { positionIndex: "asc" },
        { mediaImageId: "asc" },
      ],
    });
  },
  async loadFileStaging(scanTaskAttemptId) {
    return prisma.stgMediaImageFile.findMany({
      where: { scanTaskAttemptId },
      select: {
        mediaImageId: true,
        alt: true,
        url: true,
      },
      orderBy: { mediaImageId: "asc" },
    });
  },
  async loadCollectionStaging(scanTaskAttemptId) {
    return prisma.stgCollection.findMany({
      where: { scanTaskAttemptId },
      select: {
        collectionId: true,
        title: true,
        handle: true,
        imageAltText: true,
        imageUrl: true,
      },
      orderBy: { collectionId: "asc" },
    });
  },
  async loadArticleStaging(scanTaskAttemptId) {
    return prisma.stgArticle.findMany({
      where: { scanTaskAttemptId },
      select: {
        articleId: true,
        title: true,
        handle: true,
        imageAltText: true,
        imageUrl: true,
      },
      orderBy: { articleId: "asc" },
    });
  },
  async loadExistingFileAltTargets(input) {
    if (input.writeTargetIds.length === 0) {
      return [];
    }

    return prisma.scanResultTarget.findMany({
      where: {
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        altPlane: "FILE_ALT",
        writeTargetId: {
          in: input.writeTargetIds,
        },
      },
      select: {
        resourceType: true,
        writeTargetId: true,
        currentAltText: true,
        previewUrl: true,
        displayTitle: true,
        displayHandle: true,
      },
    });
  },
  async persistDerivedResults(result) {
    await persistDerivedResults(result);
  },
};

const derivePersistence: DerivePersistence = {
  ...defaultPersistence,
};

export function setDerivePersistenceForTests(
  overrides: Partial<DerivePersistence>,
): void {
  Object.assign(derivePersistence, overrides);
}

export function resetDerivePersistenceForTests(): void {
  Object.assign(derivePersistence, defaultPersistence);
}

export interface DeriveAndPersistInput {
  scanTaskAttemptId: string;
}

export interface DeriveExecutionResult {
  skipped: boolean;
  reason?: "ATTEMPT_NOT_FOUND" | "ATTEMPT_NOT_SUCCESS" | "ATTEMPT_NOT_LATEST";
  resourceType?: ScanResourceType;
  targetCount: number;
  usageCount: number;
  warnings: DeriveWarning[];
}

export async function deriveAndPersistScanResults(
  input: DeriveAndPersistInput,
): Promise<DeriveExecutionResult> {
  const attempt = await derivePersistence.findAttemptContext(input.scanTaskAttemptId);

  if (!attempt) {
    return {
      skipped: true,
      reason: "ATTEMPT_NOT_FOUND",
      targetCount: 0,
      usageCount: 0,
      warnings: [],
    };
  }

  if (attempt.status !== "SUCCESS") {
    return {
      skipped: true,
      reason: "ATTEMPT_NOT_SUCCESS",
      resourceType: attempt.scanTask.resourceType,
      targetCount: 0,
      usageCount: 0,
      warnings: [],
    };
  }

  if (attempt.attemptNo !== attempt.scanTask.currentAttemptNo) {
    return {
      skipped: true,
      reason: "ATTEMPT_NOT_LATEST",
      resourceType: attempt.scanTask.resourceType,
      targetCount: 0,
      usageCount: 0,
      warnings: [],
    };
  }

  const resourceType = attempt.scanTask.resourceType;
  const shopId = attempt.shopId;
  const scanJobId = attempt.scanTask.scanJobId;

  let result: DeriveComputationResult;

  switch (resourceType) {
    case "PRODUCT_MEDIA": {
      const [products, mediaRows] = await Promise.all([
        derivePersistence.loadProductStaging(input.scanTaskAttemptId),
        derivePersistence.loadProductMediaStaging(input.scanTaskAttemptId),
      ]);
      const existingTargets = await derivePersistence.loadExistingFileAltTargets({
        shopId,
        scanJobId,
        writeTargetIds: uniqueValues(mediaRows.map((row) => row.mediaImageId)),
      });
      result = deriveProductMediaResults({
        shopId,
        scanJobId,
        products,
        mediaRows,
        existingTargets,
      });
      break;
    }

    case "FILES": {
      const fileRows = await derivePersistence.loadFileStaging(
        input.scanTaskAttemptId,
      );
      const existingTargets = await derivePersistence.loadExistingFileAltTargets({
        shopId,
        scanJobId,
        writeTargetIds: uniqueValues(fileRows.map((row) => row.mediaImageId)),
      });
      result = deriveFileResults({
        shopId,
        scanJobId,
        rows: fileRows,
        existingTargets,
      });
      break;
    }

    case "COLLECTION_IMAGE": {
      const rows = await derivePersistence.loadCollectionStaging(
        input.scanTaskAttemptId,
      );
      result = deriveCollectionResults({
        shopId,
        scanJobId,
        rows,
      });
      break;
    }

    case "ARTICLE_IMAGE": {
      const rows = await derivePersistence.loadArticleStaging(
        input.scanTaskAttemptId,
      );
      result = deriveArticleResults({
        shopId,
        scanJobId,
        rows,
      });
      break;
    }

    default: {
      const unsupported: never = resourceType;
      throw new Error(`Unsupported derive resource type: ${unsupported}`);
    }
  }

  await derivePersistence.persistDerivedResults(result);

  for (const warning of result.warnings) {
    logger.warn(
      {
        scanTaskAttemptId: input.scanTaskAttemptId,
        ...warning,
      },
      "derive.file-alt-field-conflict",
    );
  }

  return {
    skipped: false,
    resourceType,
    targetCount: result.targets.length,
    usageCount: result.usages.length,
    warnings: result.warnings,
  };
}

export function deriveProductMediaResults(input: {
  shopId: string;
  scanJobId: string;
  products: ProductStagingRow[];
  mediaRows: ProductMediaStagingRow[];
  existingTargets: ExistingFileAltTarget[];
}): DeriveComputationResult {
  const productMap = new Map(
    input.products.map((product) => [product.productId, product] as const),
  );
  const groupedMedia = new Map<string, ProductMediaStagingRow[]>();

  for (const row of input.mediaRows) {
    const group = groupedMedia.get(row.mediaImageId);
    if (group) {
      group.push(row);
    } else {
      groupedMedia.set(row.mediaImageId, [row]);
    }
  }

  const existingByWriteTargetId = buildExistingFileTargetMap(input.existingTargets);
  const targets: DerivedTargetRecord[] = [];
  const usages: DerivedUsageRecord[] = [];
  const warnings: DeriveWarning[] = [];

  for (const [mediaImageId, rows] of groupedMedia) {
    const existing = existingByWriteTargetId.get(mediaImageId) ?? null;
    const canonicalResourceType = existing?.resourceType ?? "PRODUCT_MEDIA";
    let draft: FileTargetDraft = {
      writeTargetId: mediaImageId,
      previewUrl: existing?.previewUrl ?? null,
      currentAltText: existing?.currentAltText ?? null,
      displayTitle: existing?.displayTitle ?? null,
      displayHandle: existing?.displayHandle ?? null,
    };

    for (const row of rows) {
      const product = productMap.get(row.parentProductId);
      const merged = mergeFileTargetDraft({
        existingResourceType: existing?.resourceType ?? canonicalResourceType,
        incomingResourceType: "PRODUCT_MEDIA",
        current: draft,
        incoming: {
          writeTargetId: mediaImageId,
          previewUrl: row.url,
          currentAltText: row.alt,
          displayTitle: product?.title ?? null,
          displayHandle: product?.handle ?? null,
        },
      });
      draft = merged.draft;
      warnings.push(...merged.warnings);

      usages.push({
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        resourceType: canonicalResourceType,
        altPlane: "FILE_ALT",
        writeTargetId: mediaImageId,
        locale: DEFAULT_LOCALE,
        usageType: "PRODUCT",
        usageId: row.parentProductId,
        title: product?.title ?? null,
        handle: product?.handle ?? null,
        positionIndex: row.positionIndex ?? null,
      });
    }

    targets.push(toTargetRecord(input.shopId, input.scanJobId, canonicalResourceType, "FILE_ALT", draft));
  }

  return {
    targets: dedupeTargets(targets),
    usages: dedupeUsages(usages),
    warnings,
  };
}

export function deriveFileResults(input: {
  shopId: string;
  scanJobId: string;
  rows: FileStagingRow[];
  existingTargets: ExistingFileAltTarget[];
}): DeriveComputationResult {
  const existingByWriteTargetId = buildExistingFileTargetMap(input.existingTargets);
  const targets: DerivedTargetRecord[] = [];
  const usages: DerivedUsageRecord[] = [];
  const warnings: DeriveWarning[] = [];

  for (const row of input.rows) {
    const existing = existingByWriteTargetId.get(row.mediaImageId) ?? null;
    const canonicalResourceType = existing?.resourceType ?? "FILES";
    const merged = mergeFileTargetDraft({
      existingResourceType: existing?.resourceType ?? canonicalResourceType,
      incomingResourceType: "FILES",
      current: {
        writeTargetId: row.mediaImageId,
        previewUrl: existing?.previewUrl ?? null,
        currentAltText: existing?.currentAltText ?? null,
        displayTitle: existing?.displayTitle ?? null,
        displayHandle: existing?.displayHandle ?? null,
      },
      incoming: {
        writeTargetId: row.mediaImageId,
        previewUrl: row.url,
        currentAltText: row.alt,
        displayTitle: null,
        displayHandle: null,
      },
    });

    targets.push(
      toTargetRecord(
        input.shopId,
        input.scanJobId,
        canonicalResourceType,
        "FILE_ALT",
        merged.draft,
      ),
    );
    usages.push({
      shopId: input.shopId,
      scanJobId: input.scanJobId,
      resourceType: canonicalResourceType,
      altPlane: "FILE_ALT",
      writeTargetId: row.mediaImageId,
      locale: DEFAULT_LOCALE,
      usageType: "FILE",
      usageId: row.mediaImageId,
      title: null,
      handle: null,
      positionIndex: null,
    });
    warnings.push(...merged.warnings);
  }

  return {
    targets: dedupeTargets(targets),
    usages: dedupeUsages(usages),
    warnings,
  };
}

export function deriveCollectionResults(input: {
  shopId: string;
  scanJobId: string;
  rows: CollectionStagingRow[];
}): DeriveComputationResult {
  return {
    targets: dedupeTargets(
      input.rows.map((row) =>
        toTargetRecord(
          input.shopId,
          input.scanJobId,
          "COLLECTION_IMAGE",
          "COLLECTION_IMAGE_ALT",
          {
            writeTargetId: row.collectionId,
            previewUrl: row.imageUrl,
            currentAltText: row.imageAltText,
            displayTitle: row.title,
            displayHandle: row.handle,
          },
        ),
      ),
    ),
    usages: [],
    warnings: [],
  };
}

export function deriveArticleResults(input: {
  shopId: string;
  scanJobId: string;
  rows: ArticleStagingRow[];
}): DeriveComputationResult {
  return {
    targets: dedupeTargets(
      input.rows.map((row) =>
        toTargetRecord(
          input.shopId,
          input.scanJobId,
          "ARTICLE_IMAGE",
          "ARTICLE_IMAGE_ALT",
          {
            writeTargetId: row.articleId,
            previewUrl: row.imageUrl,
            currentAltText: row.imageAltText,
            displayTitle: row.title,
            displayHandle: row.handle,
          },
        ),
      ),
    ),
    usages: [],
    warnings: [],
  };
}

function buildExistingFileTargetMap(
  rows: ExistingFileAltTarget[],
): Map<string, ExistingFileAltTarget> {
  const result = new Map<string, ExistingFileAltTarget>();

  for (const row of rows) {
    const previous = result.get(row.writeTargetId);

    if (
      previous &&
      previous.resourceType !== row.resourceType &&
      isFileAltResourceType(previous.resourceType) &&
      isFileAltResourceType(row.resourceType)
    ) {
      logger.warn(
        {
          writeTargetId: row.writeTargetId,
          previousResourceType: previous.resourceType,
          nextResourceType: row.resourceType,
        },
        "derive.file-alt-duplicate-target-detected",
      );
    }

    result.set(row.writeTargetId, previous ?? row);
  }

  return result;
}

function isFileAltResourceType(
  resourceType: ScanResourceType,
): resourceType is FileAltResourceType {
  return resourceType === "PRODUCT_MEDIA" || resourceType === "FILES";
}

function mergeFileTargetDraft(input: {
  existingResourceType: ScanResourceType;
  incomingResourceType: ScanResourceType;
  current: FileTargetDraft;
  incoming: FileTargetDraft;
}): { draft: FileTargetDraft; warnings: DeriveWarning[] } {
  const warnings: DeriveWarning[] = [];
  const mergedAlt = mergeFieldWithWarning({
    currentValue: input.current.currentAltText,
    incomingValue: input.incoming.currentAltText,
    field: "currentAltText",
    writeTargetId: input.current.writeTargetId,
    existingResourceType: input.existingResourceType,
    incomingResourceType: input.incomingResourceType,
  });
  const mergedPreviewUrl = mergeFieldWithWarning({
    currentValue: input.current.previewUrl,
    incomingValue: input.incoming.previewUrl,
    field: "previewUrl",
    writeTargetId: input.current.writeTargetId,
    existingResourceType: input.existingResourceType,
    incomingResourceType: input.incomingResourceType,
  });
  warnings.push(...mergedAlt.warnings, ...mergedPreviewUrl.warnings);

  return {
    draft: {
      writeTargetId: input.current.writeTargetId,
      currentAltText: mergedAlt.value,
      previewUrl: mergedPreviewUrl.value,
      displayTitle: pickPreferIncomingNonEmpty(
        input.current.displayTitle,
        input.incoming.displayTitle,
      ),
      displayHandle: pickPreferIncomingNonEmpty(
        input.current.displayHandle,
        input.incoming.displayHandle,
      ),
    },
    warnings,
  };
}

function mergeFieldWithWarning(input: {
  currentValue: string | null;
  incomingValue: string | null;
  field: "currentAltText" | "previewUrl";
  writeTargetId: string;
  existingResourceType: ScanResourceType;
  incomingResourceType: ScanResourceType;
}): { value: string | null; warnings: DeriveWarning[] } {
  const current = normalizeOptionalText(input.currentValue);
  const incoming = normalizeOptionalText(input.incomingValue);

  if (incoming === null) {
    return {
      value: current,
      warnings: [],
    };
  }

  if (current === null) {
    return {
      value: incoming,
      warnings: [],
    };
  }

  if (current === incoming) {
    return {
      value: incoming,
      warnings: [],
    };
  }

  return {
    value: incoming,
    warnings: [
      {
        code: "FILE_ALT_FIELD_CONFLICT",
        writeTargetId: input.writeTargetId,
        field: input.field,
        existingValue: current,
        incomingValue: incoming,
        existingResourceType: input.existingResourceType,
        incomingResourceType: input.incomingResourceType,
      },
    ],
  };
}

function toTargetRecord(
  shopId: string,
  scanJobId: string,
  resourceType: ScanResourceType,
  altPlane: AltPlane,
  draft: FileTargetDraft,
): DerivedTargetRecord {
  return {
    shopId,
    scanJobId,
    resourceType,
    altPlane,
    writeTargetId: draft.writeTargetId,
    locale: DEFAULT_LOCALE,
    displayTitle: normalizeOptionalText(draft.displayTitle),
    displayHandle: normalizeOptionalText(draft.displayHandle),
    previewUrl: normalizeOptionalText(draft.previewUrl),
    currentAltText: normalizeOptionalText(draft.currentAltText),
    currentAltEmpty: isAltEmpty(draft.currentAltText),
  };
}

function dedupeTargets(targets: DerivedTargetRecord[]): DerivedTargetRecord[] {
  const result = new Map<string, DerivedTargetRecord>();

  for (const target of targets) {
    result.set(
      [
        target.shopId,
        target.scanJobId,
        target.resourceType,
        target.altPlane,
        target.writeTargetId,
        target.locale,
      ].join("::"),
      target,
    );
  }

  return [...result.values()];
}

function dedupeUsages(usages: DerivedUsageRecord[]): DerivedUsageRecord[] {
  const result = new Map<string, DerivedUsageRecord>();

  for (const usage of usages) {
    result.set(
      [
        usage.shopId,
        usage.scanJobId,
        usage.resourceType,
        usage.altPlane,
        usage.writeTargetId,
        usage.locale,
        usage.usageType,
        usage.usageId,
      ].join("::"),
      usage,
    );
  }

  return [...result.values()];
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.length > 0 ? value : null;
}

function pickPreferIncomingNonEmpty(
  currentValue: string | null,
  incomingValue: string | null,
): string | null {
  return normalizeOptionalText(incomingValue) ?? normalizeOptionalText(currentValue);
}

function isAltEmpty(value: string | null | undefined): boolean {
  return normalizeOptionalText(value) === null;
}

async function persistDerivedResults(
  result: DeriveComputationResult,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const target of result.targets) {
      await upsertResultTarget(tx, target);
    }

    for (const usage of result.usages) {
      await upsertResultUsage(tx, usage);
    }
  });
}

async function upsertResultTarget(
  tx: Prisma.TransactionClient,
  target: DerivedTargetRecord,
): Promise<void> {
  await tx.scanResultTarget.upsert({
    where: {
      shopId_scanJobId_altPlane_writeTargetId_locale: {
        shopId: target.shopId,
        scanJobId: target.scanJobId,
        altPlane: target.altPlane,
        writeTargetId: target.writeTargetId,
        locale: target.locale,
      },
    },
    create: {
      shopId: target.shopId,
      scanJobId: target.scanJobId,
      resourceType: target.resourceType,
      altPlane: target.altPlane,
      writeTargetId: target.writeTargetId,
      locale: target.locale,
      displayTitle: target.displayTitle,
      displayHandle: target.displayHandle,
      previewUrl: target.previewUrl,
      currentAltText: target.currentAltText,
      currentAltEmpty: target.currentAltEmpty,
    },
    update: {
      displayTitle: target.displayTitle,
      displayHandle: target.displayHandle,
      previewUrl: target.previewUrl,
      currentAltText: target.currentAltText,
      currentAltEmpty: target.currentAltEmpty,
    },
  });
}

async function upsertResultUsage(
  tx: Prisma.TransactionClient,
  usage: DerivedUsageRecord,
): Promise<void> {
  await tx.scanResultUsage.upsert({
    where: {
      shopId_scanJobId_resourceType_altPlane_writeTargetId_usageType_usageId: {
        shopId: usage.shopId,
        scanJobId: usage.scanJobId,
        resourceType: usage.resourceType,
        altPlane: usage.altPlane,
        writeTargetId: usage.writeTargetId,
        usageType: usage.usageType,
        usageId: usage.usageId,
      },
    },
    create: {
      shopId: usage.shopId,
      scanJobId: usage.scanJobId,
      resourceType: usage.resourceType,
      altPlane: usage.altPlane,
      writeTargetId: usage.writeTargetId,
      locale: usage.locale,
      usageType: usage.usageType,
      usageId: usage.usageId,
      title: usage.title,
      handle: usage.handle,
      positionIndex: usage.positionIndex,
    },
    update: {
      locale: usage.locale,
      title: usage.title,
      handle: usage.handle,
      positionIndex: usage.positionIndex,
    },
  });
}
