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
import { buildPrompt } from "../../server/ai/prompt-engine.server";
import { cleanAltText } from "../../server/ai/output-cleaner.server";
import { aiGatewayService } from "../../server/ai/ai-gateway";
import { AIGenerationError } from "../../server/ai/ai.types";
import { env } from "../../server/config/env";
import { GenerationBatchService } from "../../server/modules/generation/generation-batch.service";
import { ContextBuilderService } from "../../server/modules/generation/context-builder.service";
import { GenerationCreditService } from "../../server/modules/generation/generation-credit.service";
import { TruthCheckService } from "../../server/modules/generation/truth-check.service";
import prisma from "../../server/db/prisma.server";
import { publishGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
import type { GenerateAltJobData } from "../../server/queues/generate-alt.queue";
import type { ContextSnapshot } from "../../server/ai/ai.types";

const logger = createLogger({ module: "generate-alt-processor" });
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

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
  AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
]);

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
): Promise<void> {
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
    logger.info(
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
): Promise<void> {
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
    logger.info(
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
): Promise<void> {
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
    logger.info(
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

export async function processGenerateAltJob(data: GenerateAltJobData): Promise<void> {
  const candidate = await loadCandidate(data);

  if (TERMINAL_STATUSES.has(candidate.status)) {
    logger.info(
      { candidateId: data.candidateId, batchId: data.batchId, status: candidate.status },
      "generate-alt.terminal-skip",
    );
    await publishGenerationProgress(data.batchId);
    return;
  }

  if (candidate.status !== AltCandidateStatus.MISSING) {
    logger.info(
      { candidateId: data.candidateId, batchId: data.batchId, status: candidate.status },
      "generate-alt.non-processable-skip",
    );
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

    const { contextMode, contextSnapshot } =
      await ContextBuilderService.buildContext(candidate);
    buildPrompt(data.imageUrl, contextSnapshot, contextMode);

    const raw = await aiGatewayService.generateAlt({
      imageUrl: data.imageUrl,
      contextSnapshot,
      contextMode,
    });

    let generatedText: string;
    try {
      generatedText = cleanAltText(raw.altText);
    } catch (error) {
      throw new AIGenerationError(
        error instanceof Error ? error.message : "AI 输出清洗失败",
        error,
      );
    }

    await markGenerated(
      data,
      candidate,
      generatedText,
      raw.modelUsed,
      contextMode,
      contextSnapshot,
    );
  } catch (error) {
    if (error instanceof AIGenerationError) {
      await markGenerationFailed(data, candidate, error);
      return;
    }

    throw error;
  } finally {
    await publishGenerationProgress(data.batchId);
  }
}
