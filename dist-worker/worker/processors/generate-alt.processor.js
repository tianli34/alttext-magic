/**
 * File: worker/processors/generate-alt.processor.ts
 * Purpose: 处理单条 generate_alt Job，串联真值复核、上下文构建、AI 生成、落库与额度结算。
 */
import { AltCandidateStatus, } from "@prisma/client";
import { cleanAltText } from "../../server/ai/output-cleaner.server";
import { aiGatewayService } from "../../server/ai/ai-gateway";
import { AIGenerationError } from "../../server/ai/ai.types";
import { env } from "../../server/config/env";
import { GenerationBatchService } from "../../server/modules/generation/generation-batch.service";
import { ContextBuilderService } from "../../server/modules/generation/context-builder.service";
import { GenerationCreditService } from "../../server/modules/generation/generation-credit.service";
import { computeExpiresAt } from "../../server/modules/generation/alt-draft-repo";
import { TruthCheckService } from "../../server/modules/generation/truth-check.service";
import prisma from "../../server/db/prisma.server";
import { publishGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
import { recordMetric } from "../../shared/logger/metrics";
const logger = createLogger({ module: "generate-alt-processor" });
const CHINESE_SHOP_ID = "fd6e7082-a067-4cc3-9d76-a081c0a3afb9";
export const generateAltConcurrency = env.GENERATE_ALT_CONCURRENCY;
const TERMINAL_STATUSES = new Set([
    AltCandidateStatus.GENERATED,
    AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
    AltCandidateStatus.WRITTEN,
    AltCandidateStatus.RESOLVED,
    AltCandidateStatus.NOT_FOUND,
    AltCandidateStatus.DECORATIVE_SKIPPED,
    AltCandidateStatus.SKIPPED_ALREADY_FILLED,
]);
const PROCESSABLE_STATUSES = [
    AltCandidateStatus.MISSING,
    AltCandidateStatus.GENERATING,
    AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
];
const PROCESSABLE_STATUS_SET = new Set(PROCESSABLE_STATUSES);
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
async function markSkippedAlreadyFilled(data, candidate, currentAlt, log) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: { in: PROCESSABLE_STATUSES },
        },
        data: {
            status: AltCandidateStatus.SKIPPED_ALREADY_FILLED,
            errorCode: null,
            errorMessage: null,
        },
    });
    if (updated.count !== 1) {
        log.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.skip-already-filled.idempotent-skip");
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
    await GenerationBatchService.markJobFinished({
        shopId: data.shopId,
        batchId: data.batchId,
        result: "skipped",
    });
}
function toInputJsonObject(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}
async function markGenerated(data, candidate, generatedText, rawText, modelUsed, contextMode, contextSnapshot, log) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: { in: PROCESSABLE_STATUSES },
        },
        data: {
            status: AltCandidateStatus.GENERATED,
            errorCode: null,
            errorMessage: null,
        },
    });
    if (updated.count !== 1) {
        log.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.generated.idempotent-skip");
        return;
    }
    // 仅开发店铺记录加工状态
    const isDevShop = data.shopId === CHINESE_SHOP_ID;
    const processingMeta = isDevShop
        ? {
            rawText: rawText ?? null,
            processingStatus: rawText !== generatedText ? "PROCESSED" : "RAW",
        }
        : {};
    await prisma.altDraft.upsert({
        where: { altCandidateId: candidate.id },
        create: {
            shopId: data.shopId,
            altCandidateId: candidate.id,
            batchId: data.batchId,
            generatedText,
            ...processingMeta,
            modelUsed,
            contextMode,
            contextSnapshot: toInputJsonObject(contextSnapshot),
            expiresAt: computeExpiresAt(),
        },
        update: {
            batchId: data.batchId,
            generatedText,
            ...processingMeta,
            modelUsed,
            contextMode,
            contextSnapshot: toInputJsonObject(contextSnapshot),
            editedText: null,
            finalText: null,
            expiresAt: computeExpiresAt(),
        },
    });
    await GenerationCreditService.consume({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
    });
    await GenerationBatchService.markJobFinished({
        shopId: data.shopId,
        batchId: data.batchId,
        result: "completed",
    });
}
async function markGenerationFailed(data, candidate, error, log) {
    const updated = await prisma.altCandidate.updateMany({
        where: {
            id: candidate.id,
            shopId: data.shopId,
            status: { in: PROCESSABLE_STATUSES },
        },
        data: {
            status: AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
            errorCode: error.name,
            errorMessage: error.message,
        },
    });
    if (updated.count !== 1) {
        log.info({ candidateId: candidate.id, batchId: data.batchId }, "generate-alt.failed.idempotent-skip");
        return;
    }
    await GenerationCreditService.releaseReservation({
        shopId: data.shopId,
        batchId: data.batchId,
        candidateId: data.candidateId,
    });
    await GenerationBatchService.markJobFinished({
        shopId: data.shopId,
        batchId: data.batchId,
        result: "failed",
    });
}
async function persistModelCalls(data, calls) {
    if (calls.length === 0)
        return;
    await prisma.aiModelCall.createMany({
        data: calls.map((c) => ({
            shopId: data.shopId,
            candidateId: data.candidateId,
            batchId: data.batchId,
            modelName: c.modelName,
            durationMs: c.durationMs,
            status: c.status,
            failureOrigin: c.failureOrigin ?? null,
            errorMessage: c.errorMessage ?? null,
        })),
    });
}
export async function processGenerateAltJob(data) {
    const jobLogger = logger.withContext({
        batch_id: data.batchId,
        alt_plane: data.altPlane,
        job_item_id: data.candidateId,
        write_target_id: data.shopifyImageId,
    });
    // ── 指标：生成 attempt ──
    recordMetric("generate.attempt.count", 1, {
        shop_domain: data.shopId,
        batch_id: data.batchId,
        alt_plane: data.altPlane,
    });
    const candidate = await loadCandidate(data);
    if (TERMINAL_STATUSES.has(candidate.status)) {
        jobLogger.info({ candidateId: data.candidateId, status: candidate.status }, "generate-alt.terminal-skip");
        recordMetric("generate.skip.terminal", 1, {
            shop_domain: data.shopId,
            batch_id: data.batchId,
        });
        await publishGenerationProgress(data.batchId);
        return;
    }
    if (!PROCESSABLE_STATUS_SET.has(candidate.status)) {
        jobLogger.info({ candidateId: data.candidateId, status: candidate.status }, "generate-alt.non-processable-skip");
        recordMetric("generate.skip.non_processable", 1, {
            shop_domain: data.shopId,
            batch_id: data.batchId,
        });
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
            await markSkippedAlreadyFilled(data, candidate, truth.currentAlt ?? "", jobLogger);
            recordMetric("generate.skip.already_filled", 1, {
                shop_domain: data.shopId,
                batch_id: data.batchId,
            });
            return;
        }
        const locale = data.shopId === CHINESE_SHOP_ID ? "zh-CN" : "en";
        const { contextMode, contextSnapshot } = await ContextBuilderService.buildContext(candidate);
        const raw = await aiGatewayService.generateAlt({
            imageUrl: data.imageUrl,
            contextSnapshot,
            contextMode,
            locale,
        });
        await persistModelCalls(data, raw.modelCalls);
        let generatedText;
        try {
            generatedText = cleanAltText(raw.altText, locale);
        }
        catch (error) {
            throw new AIGenerationError(error instanceof Error ? error.message : "AI 输出清洗失败", error);
        }
        const successLogger = jobLogger.withContext({
            model_used: raw.modelUsed,
            context_mode: contextMode,
        });
        await markGenerated(data, candidate, generatedText, raw.altText, raw.modelUsed, contextMode, contextSnapshot, successLogger);
        // ── 指标：生成成功 ──
        recordMetric("generate.success", 1, {
            shop_domain: data.shopId,
            batch_id: data.batchId,
            model_used: raw.modelUsed,
            context_mode: contextMode,
        });
    }
    catch (error) {
        if (error instanceof AIGenerationError) {
            if (error.modelCalls) {
                await persistModelCalls(data, error.modelCalls);
            }
            const failedLogger = jobLogger.withContext({
                error_code: error.name,
                error_message: error.message,
            });
            await markGenerationFailed(data, candidate, error, failedLogger);
            // ── 指标：AI 生成失败 ──
            recordMetric(`generate.fail.${error.name}`, 1, {
                shop_domain: data.shopId,
                batch_id: data.batchId,
                error_code: error.name,
            });
            return;
        }
        const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
        const failedLogger = jobLogger.withContext({
            error_code: errorCode,
            error_message: error instanceof Error ? error.message : String(error),
        });
        // 非 AIGenerationError 兜底：标记失败而非抛出，避免候选人卡在 GENERATING
        await markGenerationFailed(data, candidate, new AIGenerationError(error instanceof Error ? error.message : "生成过程未知错误", error), failedLogger);
        // ── 指标：未知错误导致失败 ──
        recordMetric(`generate.fail.${errorCode}`, 1, {
            shop_domain: data.shopId,
            batch_id: data.batchId,
            error_code: errorCode,
        });
        return;
    }
    finally {
        await publishGenerationProgress(data.batchId);
    }
}
