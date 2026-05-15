import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
const logger = createLogger({ module: "derive-service" });
const DEFAULT_LOCALE = "default";
const FILE_ALT_RESOURCE_TYPES = ["PRODUCT_MEDIA", "FILES"];
const defaultPersistence = {
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
const derivePersistence = {
    ...defaultPersistence,
};
export function setDerivePersistenceForTests(overrides) {
    Object.assign(derivePersistence, overrides);
}
export function resetDerivePersistenceForTests() {
    Object.assign(derivePersistence, defaultPersistence);
}
export async function deriveAndPersistScanResults(input) {
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
    let result;
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
            const fileRows = await derivePersistence.loadFileStaging(input.scanTaskAttemptId);
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
            const rows = await derivePersistence.loadCollectionStaging(input.scanTaskAttemptId);
            result = deriveCollectionResults({
                shopId,
                scanJobId,
                rows,
            });
            break;
        }
        case "ARTICLE_IMAGE": {
            const rows = await derivePersistence.loadArticleStaging(input.scanTaskAttemptId);
            result = deriveArticleResults({
                shopId,
                scanJobId,
                rows,
            });
            break;
        }
        default: {
            const unsupported = resourceType;
            throw new Error(`Unsupported derive resource type: ${unsupported}`);
        }
    }
    await derivePersistence.persistDerivedResults(result);
    for (const warning of result.warnings) {
        logger.warn({
            scanTaskAttemptId: input.scanTaskAttemptId,
            ...warning,
        }, "derive.file-alt-field-conflict");
    }
    return {
        skipped: false,
        resourceType,
        targetCount: result.targets.length,
        usageCount: result.usages.length,
        warnings: result.warnings,
    };
}
export function deriveProductMediaResults(input) {
    const productMap = new Map(input.products.map((product) => [product.productId, product]));
    const groupedMedia = new Map();
    for (const row of input.mediaRows) {
        const group = groupedMedia.get(row.mediaImageId);
        if (group) {
            group.push(row);
        }
        else {
            groupedMedia.set(row.mediaImageId, [row]);
        }
    }
    const existingByWriteTargetId = buildExistingFileTargetMap(input.existingTargets);
    const targets = [];
    const usages = [];
    const warnings = [];
    for (const [mediaImageId, rows] of groupedMedia) {
        const existing = existingByWriteTargetId.get(mediaImageId) ?? null;
        const canonicalResourceType = existing?.resourceType ?? "PRODUCT_MEDIA";
        let draft = {
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
export function deriveFileResults(input) {
    const existingByWriteTargetId = buildExistingFileTargetMap(input.existingTargets);
    const targets = [];
    const usages = [];
    const warnings = [];
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
        targets.push(toTargetRecord(input.shopId, input.scanJobId, canonicalResourceType, "FILE_ALT", merged.draft));
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
export function deriveCollectionResults(input) {
    return {
        targets: dedupeTargets(input.rows.map((row) => toTargetRecord(input.shopId, input.scanJobId, "COLLECTION_IMAGE", "COLLECTION_IMAGE_ALT", {
            writeTargetId: row.collectionId,
            previewUrl: row.imageUrl,
            currentAltText: row.imageAltText,
            displayTitle: row.title,
            displayHandle: row.handle,
        }))),
        usages: [],
        warnings: [],
    };
}
export function deriveArticleResults(input) {
    return {
        targets: dedupeTargets(input.rows.map((row) => toTargetRecord(input.shopId, input.scanJobId, "ARTICLE_IMAGE", "ARTICLE_IMAGE_ALT", {
            writeTargetId: row.articleId,
            previewUrl: row.imageUrl,
            currentAltText: row.imageAltText,
            displayTitle: row.title,
            displayHandle: row.handle,
        }))),
        usages: [],
        warnings: [],
    };
}
function buildExistingFileTargetMap(rows) {
    const result = new Map();
    for (const row of rows) {
        const previous = result.get(row.writeTargetId);
        if (previous &&
            previous.resourceType !== row.resourceType &&
            isFileAltResourceType(previous.resourceType) &&
            isFileAltResourceType(row.resourceType)) {
            logger.warn({
                writeTargetId: row.writeTargetId,
                previousResourceType: previous.resourceType,
                nextResourceType: row.resourceType,
            }, "derive.file-alt-duplicate-target-detected");
        }
        result.set(row.writeTargetId, previous ?? row);
    }
    return result;
}
function isFileAltResourceType(resourceType) {
    return resourceType === "PRODUCT_MEDIA" || resourceType === "FILES";
}
function mergeFileTargetDraft(input) {
    const warnings = [];
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
            displayTitle: pickPreferIncomingNonEmpty(input.current.displayTitle, input.incoming.displayTitle),
            displayHandle: pickPreferIncomingNonEmpty(input.current.displayHandle, input.incoming.displayHandle),
        },
        warnings,
    };
}
function mergeFieldWithWarning(input) {
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
function toTargetRecord(shopId, scanJobId, resourceType, altPlane, draft) {
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
function dedupeTargets(targets) {
    const result = new Map();
    for (const target of targets) {
        result.set([
            target.shopId,
            target.scanJobId,
            target.resourceType,
            target.altPlane,
            target.writeTargetId,
            target.locale,
        ].join("::"), target);
    }
    return [...result.values()];
}
function dedupeUsages(usages) {
    const result = new Map();
    for (const usage of usages) {
        result.set([
            usage.shopId,
            usage.scanJobId,
            usage.resourceType,
            usage.altPlane,
            usage.writeTargetId,
            usage.locale,
            usage.usageType,
            usage.usageId,
        ].join("::"), usage);
    }
    return [...result.values()];
}
function uniqueValues(values) {
    return [...new Set(values)];
}
function normalizeOptionalText(value) {
    if (typeof value !== "string") {
        return null;
    }
    return value.length > 0 ? value : null;
}
function pickPreferIncomingNonEmpty(currentValue, incomingValue) {
    return normalizeOptionalText(incomingValue) ?? normalizeOptionalText(currentValue);
}
function isAltEmpty(value) {
    return normalizeOptionalText(value) === null;
}
async function persistDerivedResults(result) {
    await prisma.$transaction(async (tx) => {
        for (const target of result.targets) {
            await upsertResultTarget(tx, target);
        }
        for (const usage of result.usages) {
            await upsertResultUsage(tx, usage);
        }
    });
}
async function upsertResultTarget(tx, target) {
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
async function upsertResultUsage(tx, usage) {
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
