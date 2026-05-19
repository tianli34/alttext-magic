/**
 * File: tests/generate-alt.processor.test.ts
 * Purpose: generate_alt processor 集成测试，使用内存状态模拟 DB / Redis / Shopify / AI。
 *
 * 运行: node --import tsx tests/generate-alt.processor.test.ts
 */
import { AltCandidateStatus, AltDraftContextMode, AltPlane } from "@prisma/client";
import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "../server/ai/ai.types.js";
import { AIGenerationError } from "../server/ai/ai.types.js";
import { aiGatewayService } from "../server/ai/ai-gateway.js";
import { FallbackProvider } from "../server/ai/providers/fallback.provider.js";
import { GenerationBatchService } from "../server/modules/generation/generation-batch.service.js";
import { ContextBuilderService } from "../server/modules/generation/context-builder.service.js";
import { GenerationCreditService } from "../server/modules/generation/generation-credit.service.js";
import { TruthCheckService } from "../server/modules/generation/truth-check.service.js";
import { queueConnection } from "../server/queues/connection.js";
import type { GenerateAltJobData } from "../server/queues/generate-alt.queue.js";
import prisma from "../server/db/prisma.server.js";
import { processGenerateAltJob } from "../worker/processors/generate-alt.processor.js";

interface MockCandidate {
  id: string;
  shopId: string;
  altTargetId: string;
  status: AltCandidateStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

interface MockTarget {
  id: string;
  shopId: string;
  altPlane: AltPlane;
  writeTargetId: string;
  currentAltText: string | null;
  currentAltEmpty: boolean;
}

interface MockDraft {
  altCandidateId: string;
  generatedText: string;
  modelUsed: string;
  contextMode: AltDraftContextMode;
}

interface MockBatch {
  id: string;
  totalCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

interface MockState {
  candidates: Map<string, MockCandidate>;
  targets: Map<string, MockTarget>;
  drafts: Map<string, MockDraft>;
  batches: Map<string, MockBatch>;
  consumedKeys: Set<string>;
  releasedKeys: Set<string>;
}

interface MutablePrisma {
  altCandidate: {
    findFirst: (args: { where: { id: string; shopId: string }; include: { altTarget: true } }) => Promise<unknown>;
    updateMany: (args: {
      where: { id: string; shopId: string; status: AltCandidateStatus | { in: AltCandidateStatus[] } };
      data: Partial<MockCandidate>;
    }) => Promise<{ count: number }>;
  };
  altTarget: {
    update: (args: { where: { id: string }; data: Partial<MockTarget> }) => Promise<unknown>;
  };
  altDraft: {
    upsert: (args: {
      where: { altCandidateId: string };
      create: MockDraft;
      update: MockDraft;
    }) => Promise<unknown>;
  };
  generationBatch: {
    update: (args: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, boolean> }) => Promise<unknown>;
    findUnique: (args: { where: { id: string }; select: Record<string, boolean> }) => Promise<unknown>;
  };
  aiModelCall: {
    createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<{ count: number }>;
  };
}

interface MutableQueueConnection {
  hset: (key: string, value: Record<string, unknown>) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const message = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

function makeState(totalCount: number): MockState {
  const state: MockState = {
    candidates: new Map(),
    targets: new Map(),
    drafts: new Map(),
    batches: new Map([
      [
        "batch-1",
        {
          id: "batch-1",
          totalCount,
          completedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          status: "IN_PROGRESS",
        },
      ],
    ]),
    consumedKeys: new Set(),
    releasedKeys: new Set(),
  };

  for (let index = 1; index <= totalCount; index++) {
    const candidateId = `cand-${index}`;
    const targetId = `target-${index}`;
    state.targets.set(targetId, {
      id: targetId,
      shopId: "shop-1",
      altPlane: AltPlane.FILE_ALT,
      writeTargetId: `gid://shopify/MediaImage/${index}`,
      currentAltText: null,
      currentAltEmpty: true,
    });
    state.candidates.set(candidateId, {
      id: candidateId,
      shopId: "shop-1",
      altTargetId: targetId,
      status: AltCandidateStatus.MISSING,
      errorCode: null,
      errorMessage: null,
    });
  }

  return state;
}

function job(candidateId: string, index: number): GenerateAltJobData {
  return {
    batchId: "batch-1",
    reservationId: "reservation-1",
    candidateId,
    shopId: "shop-1",
    shopifyImageId: `gid://shopify/MediaImage/${index}`,
    altPlane: AltPlane.FILE_ALT,
    imageUrl: `https://cdn.example.com/image-${index}.jpg`,
  };
}

function installMocks(state: MockState): () => void {
  const mutablePrisma = prisma as unknown as MutablePrisma;
  const mutableQueue = queueConnection as unknown as MutableQueueConnection;

  const original = {
    findFirst: mutablePrisma.altCandidate.findFirst,
    updateMany: mutablePrisma.altCandidate.updateMany,
    targetUpdate: mutablePrisma.altTarget.update,
    draftUpsert: mutablePrisma.altDraft.upsert,
    batchUpdate: mutablePrisma.generationBatch.update,
    batchFindUnique: mutablePrisma.generationBatch.findUnique,
    modelCallCreateMany: mutablePrisma.aiModelCall.createMany,
    hset: mutableQueue.hset,
    expire: mutableQueue.expire,
    truth: TruthCheckService.checkCurrentAlt,
    context: ContextBuilderService.buildContext,
    consume: GenerationCreditService.consume,
    release: GenerationCreditService.releaseReservation,
    markJobFinished: GenerationBatchService.markJobFinished,
  };

  mutablePrisma.altCandidate.findFirst = async (args) => {
    const candidate = state.candidates.get(args.where.id);
    if (!candidate || candidate.shopId !== args.where.shopId) return null;
    const target = state.targets.get(candidate.altTargetId);
    return { ...candidate, altTarget: target };
  };

  mutablePrisma.altCandidate.updateMany = async (args) => {
    const candidate = state.candidates.get(args.where.id);
    const expectedStatus = args.where.status;
    const statusMatches = typeof expectedStatus === "string"
      ? candidate?.status === expectedStatus
      : expectedStatus.in.includes(candidate?.status as AltCandidateStatus);
    if (!candidate || candidate.shopId !== args.where.shopId || !statusMatches) {
      return { count: 0 };
    }
    Object.assign(candidate, args.data);
    return { count: 1 };
  };

  mutablePrisma.altTarget.update = async (args) => {
    const target = state.targets.get(args.where.id);
    if (!target) throw new Error("target not found");
    Object.assign(target, args.data);
    return target;
  };

  mutablePrisma.altDraft.upsert = async (args) => {
    const draft = state.drafts.has(args.where.altCandidateId) ? args.update : args.create;
    state.drafts.set(args.where.altCandidateId, {
      altCandidateId: args.where.altCandidateId,
      generatedText: draft.generatedText,
      modelUsed: draft.modelUsed,
      contextMode: draft.contextMode,
    });
    return state.drafts.get(args.where.altCandidateId);
  };

  mutablePrisma.generationBatch.update = async (args) => {
    const batch = state.batches.get(args.where.id);
    if (!batch) throw new Error("batch not found");
    const data = args.data;
    const completed = data.completedCount as { increment?: number } | undefined;
    const skipped = data.skippedCount as { increment?: number } | undefined;
    const failedCount = data.failedCount as { increment?: number } | undefined;
    batch.completedCount += completed?.increment ?? 0;
    batch.skippedCount += skipped?.increment ?? 0;
    batch.failedCount += failedCount?.increment ?? 0;
    if (typeof data.status === "string") {
      batch.status = data.status as MockBatch["status"];
    }
    return { ...batch };
  };

  mutablePrisma.generationBatch.findUnique = async (args) => {
    return state.batches.get(args.where.id) ?? null;
  };

  mutablePrisma.aiModelCall.createMany = async () => ({ count: 0 });

  mutableQueue.hset = async () => 1;
  mutableQueue.expire = async () => 1;

  TruthCheckService.checkCurrentAlt = async () => ({ isEmpty: true, currentAlt: null });
  ContextBuilderService.buildContext = async () => ({
    contextMode: AltDraftContextMode.FILE_NEUTRAL,
    contextSnapshot: { filename: "image.jpg" },
  });
  GenerationCreditService.consume = async ({ batchId, candidateId }) => {
    state.consumedKeys.add(`gen:${batchId}:${candidateId}:consume`);
    return { changed: true, reservationId: "reservation-1" };
  };
  GenerationCreditService.releaseReservation = async ({ batchId, candidateId }) => {
    state.releasedKeys.add(`gen:${batchId}:${candidateId}:release`);
    return { changed: true, reservationId: "reservation-1" };
  };
  GenerationBatchService.markJobFinished = async ({ batchId, result }) => {
    const batch = state.batches.get(batchId);
    if (!batch) throw new Error("batch not found");
    if (batch.status !== "IN_PROGRESS") {
      return {
        finalized: false,
        batch: {
          shopId: "shop-1",
          batchId: batch.id,
          status: batch.status,
          totalCount: batch.totalCount,
          completedCount: batch.completedCount,
          skippedCount: batch.skippedCount,
          failedCount: batch.failedCount,
        },
      };
    }
    batch.completedCount += 1;
    if (result === "skipped") batch.skippedCount += 1;
    if (result === "failed") batch.failedCount += 1;
    const finalized = batch.completedCount >= batch.totalCount;
    if (finalized) {
      batch.status = batch.failedCount > 0 ? "FAILED" : "COMPLETED";
    }
    return {
      finalized,
      batch: {
        shopId: "shop-1",
        batchId: batch.id,
        status: batch.status,
        totalCount: batch.totalCount,
        completedCount: batch.completedCount,
        skippedCount: batch.skippedCount,
        failedCount: batch.failedCount,
      },
    };
  };

  return () => {
    mutablePrisma.altCandidate.findFirst = original.findFirst;
    mutablePrisma.altCandidate.updateMany = original.updateMany;
    mutablePrisma.altTarget.update = original.targetUpdate;
    mutablePrisma.altDraft.upsert = original.draftUpsert;
    mutablePrisma.generationBatch.update = original.batchUpdate;
    mutablePrisma.generationBatch.findUnique = original.batchFindUnique;
    mutablePrisma.aiModelCall.createMany = original.modelCallCreateMany;
    mutableQueue.hset = original.hset;
    mutableQueue.expire = original.expire;
    TruthCheckService.checkCurrentAlt = original.truth;
    ContextBuilderService.buildContext = original.context;
    GenerationCreditService.consume = original.consume;
    GenerationCreditService.releaseReservation = original.release;
    GenerationBatchService.markJobFinished = original.markJobFinished;
  };
}

class SuccessProvider implements AIProvider {
  constructor(private readonly modelUsed = "fake-model") {}
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const filename = req.imageUrl.split("/").pop() ?? "unknown";
    return {
      altText: `Photo of ${filename}`,
      modelUsed: this.modelUsed,
      modelCalls: [{ modelName: this.modelUsed, durationMs: 100, status: "SUCCESS" }],
    };
  }
}

class FailingProvider implements AIProvider {
  constructor(private readonly message = "AI failed") {}
  async generateAlt(): Promise<GenerateAltResult> {
    throw new AIGenerationError(this.message);
  }
}

class ConditionalFailProvider implements AIProvider {
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    if (req.imageUrl.endsWith("image-2.jpg")) {
      throw new AIGenerationError("conditional failure");
    }
    const filename = req.imageUrl.split("/").pop() ?? "unknown";
    return {
      altText: `Photo of ${filename}`,
      modelUsed: "fake-model",
      modelCalls: [{ modelName: "fake-model", durationMs: 100, status: "SUCCESS" }],
    };
  }
}

async function testFiveCandidatesSuccess(): Promise<void> {
  const state = makeState(5);
  const restore = installMocks(state);
  aiGatewayService._setProvider(new SuccessProvider());

  try {
    for (let index = 1; index <= 5; index++) {
      await processGenerateAltJob(job(`cand-${index}`, index));
    }

    assertEqual(state.drafts.size, 5, "5 条 candidate 生成 5 条 draft");
    assertEqual(state.consumedKeys.size, 5, "5 条 candidate 写 5 条 CONSUME 幂等键");
    assertEqual(state.batches.get("batch-1")?.completedCount, 5, "batch completed_count = 5");
    assertEqual(state.batches.get("batch-1")?.status, "COMPLETED", "5 条全部完成后 batch = COMPLETED");
  } finally {
    restore();
  }
}

async function testTruthFilledSkipsOne(): Promise<void> {
  const state = makeState(5);
  const restore = installMocks(state);
  aiGatewayService._setProvider(new SuccessProvider());

  try {
    TruthCheckService.checkCurrentAlt = async (candidate) =>
      candidate.candidateId === "cand-1"
        ? { isEmpty: false, currentAlt: "Already filled" }
        : { isEmpty: true, currentAlt: null };

    for (let index = 1; index <= 5; index++) {
      await processGenerateAltJob(job(`cand-${index}`, index));
    }

    assertEqual(state.candidates.get("cand-1")?.status, AltCandidateStatus.SKIPPED_ALREADY_FILLED, "真值非空 candidate 标记 SKIPPED");
    assertEqual(state.drafts.size, 4, "真值非空时仅 4 条 draft");
    assertEqual(state.consumedKeys.size, 4, "真值非空时仅 4 条扣费");
    assertEqual(state.releasedKeys.size, 1, "真值非空释放 1 条预留");
    assertEqual(state.batches.get("batch-1")?.status, "COMPLETED", "仅 skipped 无 failed 时 batch = COMPLETED");
  } finally {
    restore();
  }
}

async function testMixedSkippedAndFailed(): Promise<void> {
  const state = makeState(5);
  const restore = installMocks(state);
  aiGatewayService._setProvider(new ConditionalFailProvider());

  try {
    TruthCheckService.checkCurrentAlt = async (candidate) =>
      candidate.candidateId === "cand-1"
        ? { isEmpty: false, currentAlt: "Already filled" }
        : { isEmpty: true, currentAlt: null };

    for (let index = 1; index <= 5; index++) {
      await processGenerateAltJob(job(`cand-${index}`, index));
    }

    assertEqual(state.consumedKeys.size, 3, "1 skipped + 1 failed 时仅消费 3 条");
    assertEqual(state.releasedKeys.size, 2, "1 skipped + 1 failed 时释放 2 条预留");
    assertEqual(state.batches.get("batch-1")?.skippedCount, 1, "混合结果 skipped_count = 1");
    assertEqual(state.batches.get("batch-1")?.failedCount, 1, "混合结果 failed_count = 1");
    assertEqual(state.batches.get("batch-1")?.status, "FAILED", "存在 failed 时 batch = FAILED");
  } finally {
    restore();
  }
}

async function testFallbackSuccess(): Promise<void> {
  const state = makeState(1);
  const restore = installMocks(state);
  aiGatewayService._setProvider(
    new FallbackProvider([
      { provider: new FailingProvider("primary timeout"), name: "primary" },
      { provider: new SuccessProvider("fallback-model"), name: "fallback" },
    ]),
  );

  try {
    await processGenerateAltJob(job("cand-1", 1));
    assertEqual(state.drafts.get("cand-1")?.modelUsed, "fallback-model", "主模型失败后 draft.model_used 为副模型");
  } finally {
    restore();
  }
}

async function testAllProvidersFail(): Promise<void> {
  const state = makeState(1);
  const restore = installMocks(state);
  aiGatewayService._setProvider(new FailingProvider("all failed"));

  try {
    await processGenerateAltJob(job("cand-1", 1));
    assertEqual(state.candidates.get("cand-1")?.status, AltCandidateStatus.GENERATION_FAILED_RETRYABLE, "全部失败标记 GENERATION_FAILED_RETRYABLE");
    assertEqual(state.releasedKeys.size, 1, "全部失败释放 1 条预留");
    assertEqual(state.batches.get("batch-1")?.failedCount, 1, "全部失败 failed_count +1");
    assertEqual(state.batches.get("batch-1")?.status, "FAILED", "全部失败时 batch = FAILED");
  } finally {
    restore();
  }
}

async function testDuplicateJobIdempotent(): Promise<void> {
  const state = makeState(1);
  const restore = installMocks(state);
  aiGatewayService._setProvider(new SuccessProvider());

  try {
    await processGenerateAltJob(job("cand-1", 1));
    await processGenerateAltJob(job("cand-1", 1));

    assertEqual(state.drafts.size, 1, "重复 Job 不重复创建 draft");
    assertEqual(state.consumedKeys.size, 1, "重复 Job 不重复扣费");
    assertEqual(state.batches.get("batch-1")?.completedCount, 1, "重复 Job 不重复递增 completed_count");
  } finally {
    restore();
  }
}

async function run(): Promise<void> {
  console.log("\n=== generate-alt.processor.test.ts ===");

  await testFiveCandidatesSuccess();
  await testTruthFilledSkipsOne();
  await testMixedSkippedAndFailed();
  await testFallbackSuccess();
  await testAllProvidersFail();
  await testDuplicateJobIdempotent();

  console.log(`\n总计: ${passed + failed} 通过: ${passed} 失败: ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败详情:");
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

run().catch((error: unknown) => {
  console.error("测试执行失败:", error);
  process.exit(1);
});
