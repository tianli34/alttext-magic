/**
 * File: worker/processors/generate-alt.processor.ts
 * Purpose: 处理单条 generate_alt Job，串联真值复核、上下文构建、AI 生成、落库与额度结算。
 */
import { AltCandidateStatus, GenerationBatchStatus, } from "@prisma/client";
import { buildPrompt } from "../../server/ai/prompt-engine.server";
import { cleanAltText } from "../../server/ai/output-cleaner.server";
import { aiGatewayService } from "../../server/ai/ai-gateway";
import { AIGenerationError } from "../../server/ai/ai.types";
import { env } from "../../server/config/env";
import { ContextBuilderService } from "../../server/modules/generation/context-builder.service";
import { GenerationCreditService } from "../../server/modules/generation/generation-credit.service";
import { TruthCheckService } from "../../server/modules/generation/truth-check.service";
import prisma from "../../server/db/prisma.server";
import { publishGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
const logger = createLogger({ module: "generate-alt-processor" });
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const generateAltConcurrency = env.GENERATE_ALT_CONCURRENCY;
const TERMINAL_STATUSES = new Set([
    AltCandidateStatus.GENERATED,
    AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
    AltCandidateStatus.WRITTEN,
    AltCandidateStatus.RESOLVED,
    AltCandidateStatus.NOT_FOUND,
    AltCandidateStatus.DECORATIVE_SKIPPED,
    AltCandidateStatus.SKIPPED_ALREADY_FILLED,
    AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
]);
async function loadCandidate(data) {
    const candidate = await prisma.altCandidate.findFirst({
        where: {
            id: data.candidateId,
            shopId: data.shopId,
        },
        include: { altTarget: true },
    });
    if (!candidate) {
        throw new Error(`[generate-alt] candidate 不存在: ${data.candidateId}`);
    }
    return candidate;
}
async function markBatchProgress(batchId, counter) {
    const increment = counter === "skipped"
        ? { completedCount: { increment: 1 }, skippedCount: { increment: 1 } }
        : counter === "failed"
            ? { completedCount: { increment: 1 }, failedCount: { increment: 1 } }
            : { completedCount: { increment: 1 } };
    const batch = await prisma.generationBatch.update({
        where: { id: batchId },
        data: increment,
        select: {
            totalCount: true,
            completedCount: true,
            failedCount: true,
        },
    });
    if (batch.completedCount >= batch.totalCount) {
        await prisma.generationBatch.update({
            where: { id: batchId },
            data: {
                status: batch.failedCount > 0
                    ? GenerationBatchStatus.FAILED
                    : GenerationBatchStatus.COMPLETED,
            },
        });
    }
}
async function markSkippedAlreadyFilled(data, candidate, currentAlt) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: AltCandidateStatus.MISSING,
        },
        data: {
            status: AltCandidateStatus.SKIPPED_ALREADY_FILLED,
            errorCode: null,
            errorMessage: null,
        },
    });
    if (updated.count !== 1) {
        logger.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.skip-already-filled.idempotent-skip");
        return;
    }
    await prisma.altTarget.update({
        where: { id: candidate.altTargetId },
        data: {
            currentAltText: currentAlt,
            currentAltEmpty: false,
        },
    });
    await GenerationCreditService.releaseReservation({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
    });
    await markBatchProgress(data.batchId, "skipped");
}
function toInputJsonObject(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}
async function markGenerated(data, candidate, generatedText, modelUsed, contextMode, contextSnapshot) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: AltCandidateStatus.MISSING,
        },
        data: {
            status: AltCandidateStatus.GENERATED,
            errorCode: null,
            errorMessage: null,
        },
    });
    if (updated.count !== 1) {
        logger.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.generated.idempotent-skip");
        return;
    }
    await prisma.altDraft.upsert({
        where: { altCandidateId: candidate.id },
        create: {
            shopId: data.shopId,
            altCandidateId: candidate.id,
            batchId: data.batchId,
            generatedText,
            modelUsed,
            contextMode,
            contextSnapshot: toInputJsonObject(contextSnapshot),
            expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
        },
        update: {
            batchId: data.batchId,
            generatedText,
            modelUsed,
            contextMode,
            contextSnapshot: toInputJsonObject(contextSnapshot),
            editedText: null,
            finalText: null,
            expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
        },
    });
    await GenerationCreditService.consume({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
    });
    await markBatchProgress(data.batchId, "completed");
}
async function markGenerationFailed(data, candidate, error) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: AltCandidateStatus.MISSING,
        },
        data: {
            status: AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
            errorCode: error.name,
            errorMessage: error.message,
        },
    });
    if (updated.count !== 1) {
        logger.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.failed.idempotent-skip");
        return;
    }
    await GenerationCreditService.releaseReservation({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
    });
    await markBatchProgress(data.batchId, "failed");
}
export async function processGenerateAltJob(data) {
    const candidate = await loadCandidate(data);
    if (TERMINAL_STATUSES.has(candidate.status)) {
        logger.info({ candidateId: data.candidateId, batchId: data.batchId, status: candidate.status }, "generate-alt.terminal-skip");
        await publishGenerationProgress(data.batchId);
        return;
    }
    if (candidate.status !== AltCandidateStatus.MISSING) {
        logger.info({ candidateId: data.candidateId, batchId: data.batchId, status: candidate.status }, "generate-alt.non-processable-skip");
        await publishGenerationProgress(data.batchId);
        return;
    }
    try {
        const truth = await TruthCheckService.checkCurrentAlt({
            candidateId: candidate.id,
            shopId: data.shopId,
            altPlane: data.altPlane,
            writeTargetId: data.shopifyImageId,
        });
        if (!truth.isEmpty) {
            await markSkippedAlreadyFilled(data, candidate, truth.currentAlt ?? "");
            return;
        }
        const { contextMode, contextSnapshot } = await ContextBuilderService.buildContext(candidate);
        buildPrompt(data.imageUrl, contextSnapshot, contextMode);
        const raw = await aiGatewayService.generateAlt({
            imageUrl: data.imageUrl,
            contextSnapshot,
            contextMode,
        });
        let generatedText;
        try {
            generatedText = cleanAltText(raw.altText);
        }
        catch (error) {
            throw new AIGenerationError(error instanceof Error ? error.message : "AI 输出清洗失败", error);
        }
        await markGenerated(data, candidate, generatedText, raw.modelUsed, contextMode, contextSnapshot);
    }
    catch (error) {
        if (error instanceof AIGenerationError) {
            await markGenerationFailed(data, candidate, error);
            return;
        }
        throw error;
    }
    finally {
        await publishGenerationProgress(data.batchId);
    }
}
