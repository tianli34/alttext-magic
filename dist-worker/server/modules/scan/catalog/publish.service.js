/**
 * File: server/modules/scan/catalog/publish.service.ts
 * Purpose: 将 `scan_result_*` 原子发布到正式表，仅替换成功资源类型对应切片。
 */
import { Prisma, } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
const logger = createLogger({ module: "publish-service" });
const DEFAULT_LOCALE = "default";
const FILE_ALT_RESOURCE_TYPES = new Set([
    "PRODUCT_MEDIA",
    "FILES",
]);
const SUCCESSFUL_STATUSES = new Set([
    "SUCCESS",
    "PARTIAL_SUCCESS",
]);
const ALL_SCAN_RESOURCE_TYPES = [
    "PRODUCT_MEDIA",
    "FILES",
    "COLLECTION_IMAGE",
    "ARTICLE_IMAGE",
];
export async function publishScanResult(input) {
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
    const successfulResourceTypes = parseSuccessfulResourceTypes(scanJob.successfulResourceTypes);
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
    // [DEBUG] 诊断日志：追踪 derive 结果中的 PRODUCT_MEDIA 数据量
    logger.info({
        shopId: scanJob.shopId,
        scanJobId: scanJob.id,
        successfulResourceTypes,
        resultTargetCount: resultTargets.length,
        resultTargetResourceTypes: [...new Set(resultTargets.map((t) => t.resourceType))],
        resultUsageCount: resultUsages.length,
        resultUsageResourceTypes: [...new Set(resultUsages.map((u) => u.resourceType))],
        productMediaUsageCount: resultUsages.filter((u) => u.resourceType === "PRODUCT_MEDIA").length,
    }, "publish.derive-input-debug");
    const resultTargetMap = new Map();
    for (const target of resultTargets) {
        resultTargetMap.set(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale), target);
    }
    const now = new Date();
    const counts = await prisma.$transaction(async (tx) => {
        const impactedTargetIds = new Set();
        let publishedTargetCount = 0;
        let publishedUsageCount = 0;
        const successfulSet = new Set(successfulResourceTypes);
        const fileUsageRows = resultUsages.filter((usage) => FILE_ALT_RESOURCE_TYPES.has(usage.resourceType));
        const fileWriteTargetIds = new Set(fileUsageRows
            .filter((usage) => successfulSet.has(usage.resourceType))
            .map((usage) => usage.writeTargetId));
        if (fileWriteTargetIds.size > 0) {
            const fileTargetsToPublish = dedupeTargets([...fileWriteTargetIds]
                .map((writeTargetId) => resultTargetMap.get(buildTargetSliceKey("FILE_ALT", writeTargetId, DEFAULT_LOCALE)))
                .filter(isNonNull));
            const altTargetIdByWriteTargetId = new Map();
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
                    currentUsageKeys: new Set(fileUsageRows
                        .filter((usage) => usage.resourceType === "PRODUCT_MEDIA")
                        .map((usage) => {
                        const altTargetId = altTargetIdByWriteTargetId.get(usage.writeTargetId);
                        return altTargetId ? buildUsageSliceKey(altTargetId, usage.usageType, usage.usageId) : null;
                    })
                        .filter(isNonNull)),
                    scanJobId: scanJob.id,
                });
                sweptTargetIds.forEach((targetId) => impactedTargetIds.add(targetId));
            }
            if (successfulSet.has("FILES")) {
                const sweptTargetIds = await sweepUsageSlice(tx, {
                    shopId: scanJob.shopId,
                    usageType: "FILE",
                    currentUsageKeys: new Set(fileUsageRows
                        .filter((usage) => usage.resourceType === "FILES")
                        .map((usage) => {
                        const altTargetId = altTargetIdByWriteTargetId.get(usage.writeTargetId);
                        return altTargetId ? buildUsageSliceKey(altTargetId, usage.usageType, usage.usageId) : null;
                    })
                        .filter(isNonNull)),
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
                resultTargets: resultTargets.filter((target) => target.resourceType === "COLLECTION_IMAGE"),
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
                resultTargets: resultTargets.filter((target) => target.resourceType === "ARTICLE_IMAGE"),
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
        const candidateByTargetId = new Map();
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
        // [DEBUG] 诊断日志：追踪 presentUsages 中 PRODUCT 类型数量
        const productPresentUsages = presentUsages.filter((u) => u.usageType === "PRODUCT");
        if (presentUsages.length > 0) {
            logger.info({
                shopId: scanJob.shopId,
                scanJobId: scanJob.id,
                impactedTargetCount: impactedTargetIds.size,
                totalPresentUsages: presentUsages.length,
                productPresentUsageCount: productPresentUsages.length,
                filePresentUsageCount: presentUsages.filter((u) => u.usageType === "FILE").length,
            }, "publish.present-usages-debug");
        }
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
        // [DEBUG] 诊断日志：追踪 lastPublishedScopeFlags 写入值
        const scopeFlagsToWrite = normalizeJsonForPrisma(scanJob.scopeFlags);
        logger.info({
            shopId: scanJob.shopId,
            scanJobId: scanJob.id,
            scopeFlags: scanJob.scopeFlags,
            successfulResourceTypes,
            projectionCount,
        }, "publish.last-published-scope-flags-debug");
        await tx.shop.update({
            where: { id: scanJob.shopId },
            data: {
                lastPublishedScanJobId: scanJob.id,
                lastPublishedAt: now,
                lastPublishedScopeFlags: scopeFlagsToWrite,
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
    logger.info({
        shopId: input.shopId,
        scanJobId: input.scanJobId,
        successfulResourceTypes,
        ...counts,
    }, "publish-scan.success");
    return {
        skipped: false,
        ...counts,
    };
}
function skippedResult(reason) {
    return {
        skipped: true,
        reason,
        publishedTargetCount: 0,
        publishedUsageCount: 0,
        candidateCount: 0,
        projectionCount: 0,
    };
}
function parseSuccessfulResourceTypes(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => {
        return (typeof item === "string" &&
            ALL_SCAN_RESOURCE_TYPES.includes(item));
    });
}
function dedupeTargets(targets) {
    const result = new Map();
    for (const target of targets) {
        result.set(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale), target);
    }
    return [...result.values()];
}
function buildTargetSliceKey(altPlane, writeTargetId, locale) {
    return [altPlane, writeTargetId, locale].join("::");
}
function buildUsageSliceKey(altTargetId, usageType, usageId) {
    return [altTargetId, usageType, usageId].join("::");
}
async function upsertPublishedTarget(tx, input) {
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
async function upsertPublishedUsage(tx, input) {
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
async function sweepUsageSlice(tx, input) {
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
    const absentRows = existing.filter((row) => !input.currentUsageKeys.has(buildUsageSliceKey(row.altTargetId, row.usageType, row.usageId)));
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
async function recomputeFileAltPresentStatus(tx, input) {
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
    const hasPresentByTargetId = new Map();
    for (const usage of usages) {
        if (usage.presentStatus === "PRESENT") {
            hasPresentByTargetId.set(usage.altTargetId, true);
        }
        else if (!hasPresentByTargetId.has(usage.altTargetId)) {
            hasPresentByTargetId.set(usage.altTargetId, false);
        }
    }
    for (const targetId of input.targetIds) {
        await tx.altTarget.update({
            where: { id: targetId },
            data: {
                presentStatus: resolveFileAltPresentStatus(hasPresentByTargetId.get(targetId) ? ["PRESENT"] : ["NOT_FOUND"]),
                lastPublishedScanJobId: input.scanJobId,
            },
        });
    }
}
async function publishSingleTargetSlice(tx, input) {
    const impactedTargetIds = new Set();
    const currentKeys = new Set();
    for (const target of input.resultTargets) {
        const publishedTarget = await upsertPublishedTarget(tx, {
            ...target,
            lastPublishedScanJobId: input.scanJobId,
            lastSeenAt: input.now,
            presentStatus: "PRESENT",
        });
        impactedTargetIds.add(publishedTarget.id);
        currentKeys.add(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale));
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
        .filter((target) => !currentKeys.has(buildTargetSliceKey(target.altPlane, target.writeTargetId, target.locale)))
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
export function computeNextCandidateState(input) {
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
    const hasActiveDraft = input.target.altCandidate?.draft !== null &&
        input.target.altCandidate?.draft !== undefined &&
        input.target.altCandidate.draft.expiresAt.getTime() > input.now.getTime();
    if (hasActiveDraft) {
        return {
            status: input.target.altCandidate?.status === "WRITEBACK_FAILED_RETRYABLE"
                ? "WRITEBACK_FAILED_RETRYABLE"
                : "GENERATED",
            missingReason: null,
        };
    }
    return {
        status: input.target.altCandidate?.status === "GENERATION_FAILED_RETRYABLE"
            ? "GENERATION_FAILED_RETRYABLE"
            : "MISSING",
        missingReason: "EMPTY",
    };
}
export function resolveFileAltPresentStatus(presentStatuses) {
    return presentStatuses.includes("PRESENT") ? "PRESENT" : "NOT_FOUND";
}
function groupPresentUsagesByTargetId(usages) {
    const result = new Map();
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
        }
        else {
            result.set(usage.altTargetId, [entry]);
        }
    }
    return result;
}
async function rebuildTargetProjections(tx, input) {
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
        }
        else {
            // [DEBUG] 诊断日志：PRODUCT_MEDIA 投影被删除（无 PRODUCT usage）
            logger.info({
                shopId: input.shopId,
                scanJobId: input.scanJobId,
                altTargetId: input.target.id,
                altCandidateId: input.altCandidateId,
                writeTargetId: input.target.writeTargetId,
                presentStatus: input.target.presentStatus,
                totalUsageCount,
                productUsageCount: productUsages.length,
                fileUsageCount: fileUsages.length,
            }, "publish.product-media-projection-deleted");
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
        }
        else {
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
function compareProductUsage(left, right) {
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
async function upsertGroupProjection(tx, input) {
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
async function deleteGroupProjection(tx, shopId, altCandidateId, groupType) {
    await tx.candidateGroupProjection.deleteMany({
        where: {
            shopId,
            altCandidateId,
            groupType,
        },
    });
}
function isNonNull(value) {
    return value !== null && value !== undefined;
}
function normalizeJsonForPrisma(value) {
    return value === null ? Prisma.JsonNull : value;
}
