/**
 * File: worker/processors/generate-alt.processor.ts
 * Purpose: 处理单条 generate_alt Job，串联真值复核、上下文构建、AI 生成、落库与额度结算。
 */
import {
  AltCandidateStatus,
  Prisma,
  type AltCandidate,
  type AltTarget,
} from "@prisma/client";
import { cleanAltText } from "../../server/ai/output-cleaner.server";
import { aiGatewayService } from "../../server/ai/ai-gateway";
import { AIGenerationError } from "../../server/ai/ai.types";
import type { ModelCallRecord } from "../../server/ai/ai.types";
import { env } from "../../server/config/env";
import { GenerationBatchService } from "../../server/modules/generation/generation-batch.service";
import { ContextBuilderService } from "../../server/modules/generation/context-builder.service";
import { GenerationCreditService } from "../../server/modules/generation/generation-credit.service";
import { DRAFT_TTL_MS, computeExpiresAt } from "../../server/modules/generation/alt-draft-repo";
import { TruthCheckService } from "../../server/modules/generation/truth-check.service";
import prisma from "../../server/db/prisma.server";
import { publishGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger, type ExtendedLogger } from "../../server/utils/logger";
import { recordMetric } from "../../shared/logger/metrics";
import type { GenerateAltJobData } from "../../server/queues/generate-alt.queue";
import type { ContextSnapshot } from "../../server/ai/ai.types";

const logger = createLogger({ module: "generate-alt-processor" });

const CHINESE_SHOP_ID = "cmnidr9hh0000bsttv2rx99xq";

export const generateAltConcurrency = env.GENERATE_ALT_CONCURRENCY;

type CandidateWithTarget = AltCandidate & { altTarget: AltTarget };

const TERMINAL_STATUSES = new Set<AltCandidateStatus>([
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
const PROCESSABLE_STATUS_SET = new Set<AltCandidateStatus>(PROCESSABLE_STATUSES);

async function loadCandidate(data: GenerateAltJobData): Promise<CandidateWithTarget> {
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

async function markSkippedAlreadyFilled(
  data: GenerateAltJobData,
  candidate: CandidateWithTarget,
  currentAlt: string,
  log: ExtendedLogger,
): Promise<void> {
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
    log.info(
      { candidateId: candidate.id, batchId: data.batchId },
      "generate-alt.skip-already-filled.idempotent-skip",
    );
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

function toInputJsonObject(snapshot: ContextSnapshot): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject;
}

async function markGenerated(
  data: GenerateAltJobData,
  candidate: CandidateWithTarget,
  generatedText: string,
  modelUsed: string,
  contextMode: Awaited<ReturnType<typeof ContextBuilderService.buildContext>>["contextMode"],
  contextSnapshot: Awaited<ReturnType<typeof ContextBuilderService.buildContext>>["contextSnapshot"],
  log: ExtendedLogger,
): Promise<void> {
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
    log.info(
      { candidateId: candidate.id, batchId: data.batchId },
      "generate-alt.generated.idempotent-skip",
    );
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
      expiresAt: computeExpiresAt(),
    },
    update: {
      batchId: data.batchId,
      generatedText,
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

async function markGenerationFailed(
  data: GenerateAltJobData,
  candidate: CandidateWithTarget,
  error: AIGenerationError,
  log: ExtendedLogger,
): Promise<void> {
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
    log.info(
      { candidateId: candidate.id, batchId: data.batchId },
      "generate-alt.failed.idempotent-skip",
    );
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

async function persistModelCalls(
  data: { shopId: string; candidateId?: string; batchId?: string },
  calls: ModelCallRecord[],
): Promise<void> {
  if (calls.length === 0) return;

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

export async function processGenerateAltJob(data: GenerateAltJobData): Promise<void> {
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
    jobLogger.info(
      { candidateId: data.candidateId, status: candidate.status },
      "generate-alt.terminal-skip",
    );
    recordMetric("generate.skip.terminal", 1, {
      shop_domain: data.shopId,
      batch_id: data.batchId,
    });
    await publishGenerationProgress(data.batchId);
    return;
  }

  if (!PROCESSABLE_STATUS_SET.has(candidate.status)) {
    jobLogger.info(
      { candidateId: data.candidateId, status: candidate.status },
      "generate-alt.non-processable-skip",
    );
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

    const locale: "en" | "zh-CN" =
      data.shopId === CHINESE_SHOP_ID ? "zh-CN" : "en";

    const { contextMode, contextSnapshot } =
      await ContextBuilderService.buildContext(candidate);

    const raw = await aiGatewayService.generateAlt({
      imageUrl: data.imageUrl,
      contextSnapshot,
      contextMode,
      locale,
    });

    await persistModelCalls(data, raw.modelCalls);

    let generatedText: string;
    try {
      generatedText = cleanAltText(raw.altText, locale);
    } catch (error) {
      throw new AIGenerationError(
        error instanceof Error ? error.message : "AI 输出清洗失败",
        error,
      );
    }

    const successLogger = jobLogger.withContext({
      model_used: raw.modelUsed,
      context_mode: contextMode,
    });
await markGenerated(
  data,
  candidate,
  generatedText,
  raw.modelUsed,
  contextMode,
  contextSnapshot,
  successLogger,
);

// ── 指标：生成成功 ──
recordMetric("generate.success", 1, {
  shop_domain: data.shopId,
  batch_id: data.batchId,
  model_used: raw.modelUsed,
  context_mode: contextMode,
});
  } catch (error) {
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
    await markGenerationFailed(
      data,
      candidate,
      new AIGenerationError(
        error instanceof Error ? error.message : "生成过程未知错误",
        error,
      ),
      failedLogger,
    );

    // ── 指标：未知错误导致失败 ──
    recordMetric(`generate.fail.${errorCode}`, 1, {
      shop_domain: data.shopId,
      batch_id: data.batchId,
      error_code: errorCode,
    });
    return;
  } finally {
    await publishGenerationProgress(data.batchId);
  }
}
