/**
 * File: tests/writeback.processor.test.ts
 * Purpose: writeback processor 集成式单测，覆盖成功写回、二次读跳过、mutation 失败与 batch 收尾。
 *
 * 运行: node --import tsx tests/writeback.processor.test.ts
 */
import assert from "node:assert/strict";
import {
  AltCandidateStatus,
  AltPlane,
  JobBatchStatus,
  JobItemStatus,
  type PrismaClient,
} from "@prisma/client";
import type { Session } from "@shopify/shopify-api";
import { encryptToken } from "../server/crypto/token-encryption";
import type { WritebackJobData } from "../server/queues/writeback.queue";
import type {
  MutationExecutor,
  WritebackResult,
} from "../server/modules/writeback/writeback.types";
import {
  processWritebackJob,
  type WritebackProcessorDependencies,
} from "../worker/processors/writeback.processor";

interface MockTarget {
  id: string;
  shopId: string;
  altPlane: AltPlane;
  writeTargetId: string;
  currentAltText: string | null;
  currentAltEmpty: boolean;
}

interface MockDraft {
  id: string;
  shopId: string;
  altCandidateId: string;
  modelUsed: string;
  generatedText: string;
  editedText: string | null;
  finalText: string | null;
}

interface MockCandidate {
  id: string;
  shopId: string;
  altTargetId: string;
  status: AltCandidateStatus;
  writtenAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface MockJobItem {
  id: string;
  batchId: string;
  altCandidateId: string;
  status: JobItemStatus;
  error: string | null;
}

interface MockBatch {
  id: string;
  shopId: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  status: JobBatchStatus;
  finishedAt: Date | null;
}

interface MockAuditLog {
  shopId: string;
  jobBatchId: string;
  altCandidateId: string;
  altTargetId: string;
  oldAltText: string | null;
  newAltText: string;
  modelUsed: string;
}

interface MockState {
  targets: Map<string, MockTarget>;
  drafts: Map<string, MockDraft>;
  candidates: Map<string, MockCandidate>;
  items: Map<string, MockJobItem>;
  batches: Map<string, MockBatch>;
  auditLogs: MockAuditLog[];
  releasedLocks: string[];
}

function itemKey(batchId: string, candidateId: string): string {
  return `${batchId}:${candidateId}`;
}

function makeJob(candidateId: string): WritebackJobData {
  return {
    shopId: "shop-1",
    candidateId,
    batchId: "batch-1",
    lockId: "lock-1",
    altPlane: AltPlane.FILE_ALT,
    shopifyGid: `gid://shopify/MediaImage/${candidateId}`,
    altText: `queued ${candidateId}`,
  };
}

function makeState(): MockState {
  const state: MockState = {
    targets: new Map(),
    drafts: new Map(),
    candidates: new Map(),
    items: new Map(),
    batches: new Map([
      [
        "batch-1",
        {
          id: "batch-1",
          shopId: "shop-1",
          total: 3,
          success: 0,
          failed: 0,
          skipped: 0,
          status: JobBatchStatus.RUNNING,
          finishedAt: null,
        },
      ],
    ]),
    auditLogs: [],
    releasedLocks: [],
  };

  for (const id of ["c1", "c2", "c3"]) {
    const targetId = `target-${id}`;
    state.targets.set(targetId, {
      id: targetId,
      shopId: "shop-1",
      altPlane: AltPlane.FILE_ALT,
      writeTargetId: `gid://shopify/MediaImage/${id}`,
      currentAltText: null,
      currentAltEmpty: true,
    });
    state.candidates.set(id, {
      id,
      shopId: "shop-1",
      altTargetId: targetId,
      status: AltCandidateStatus.GENERATED,
      writtenAt: null,
      errorCode: null,
      errorMessage: null,
    });
    state.drafts.set(id, {
      id: `draft-${id}`,
      shopId: "shop-1",
      altCandidateId: id,
      modelUsed: "test-model",
      generatedText: `generated ${id}`,
      editedText: id === "c1" ? "edited c1" : null,
      finalText: null,
    });
    state.items.set(itemKey("batch-1", id), {
      id: `item-${id}`,
      batchId: "batch-1",
      altCandidateId: id,
      status: JobItemStatus.PENDING,
      error: null,
    });
  }

  return state;
}

class StaticExecutor implements MutationExecutor {
  constructor(private readonly result: WritebackResult) {}

  async execute(_params: {
    session: Session;
    shopifyGid: string;
    altText: string;
  }): Promise<WritebackResult> {
    return this.result;
  }
}

function createMockPrisma(state: MockState): PrismaClient {
  const encrypted = encryptToken("offline-token");

  const txClient = {
    altCandidate: {
      findFirst: async (args: { where: { id: string; shopId: string } }) => {
        const candidate = state.candidates.get(args.where.id);
        if (!candidate || candidate.shopId !== args.where.shopId) return null;
        return {
          ...candidate,
          altTarget: state.targets.get(candidate.altTargetId),
          draft: state.drafts.get(candidate.id) ?? null,
        };
      },
      update: async (args: { where: { id: string }; data: Partial<MockCandidate> }) => {
        const candidate = state.candidates.get(args.where.id);
        if (!candidate) throw new Error("candidate not found");
        Object.assign(candidate, args.data);
        return candidate;
      },
      updateMany: async (args: {
        where: {
          id: string;
          shopId: string;
          status?: AltCandidateStatus | { in: AltCandidateStatus[] };
        };
        data: Partial<MockCandidate>;
      }) => {
        const candidate = state.candidates.get(args.where.id);
        const expected = args.where.status;
        const statusMatches = expected === undefined
          || (typeof expected === "string"
            ? candidate?.status === expected
            : expected.in.includes(candidate?.status as AltCandidateStatus));

        if (!candidate || candidate.shopId !== args.where.shopId || !statusMatches) {
          return { count: 0 };
        }

        Object.assign(candidate, args.data);
        return { count: 1 };
      },
    },
    altDraft: {
      update: async (args: {
        where: { altCandidateId: string };
        data: Partial<MockDraft>;
      }) => {
        const draft = state.drafts.get(args.where.altCandidateId);
        if (!draft) throw new Error("draft not found");
        Object.assign(draft, args.data);
        return draft;
      },
    },
    altTarget: {
      update: async (args: { where: { id: string }; data: Partial<MockTarget> }) => {
        const target = state.targets.get(args.where.id);
        if (!target) throw new Error("target not found");
        Object.assign(target, args.data);
        return target;
      },
    },
    auditLog: {
      create: async (args: { data: MockAuditLog }) => {
        state.auditLogs.push(args.data);
        return args.data;
      },
    },
    jobItem: {
      updateMany: async (args: {
        where: {
          batchId: string;
          altCandidateId: string;
          status: JobItemStatus | { in: JobItemStatus[] };
        };
        data: Partial<MockJobItem>;
      }) => {
        const item = state.items.get(itemKey(args.where.batchId, args.where.altCandidateId));
        const expected = args.where.status;
        const statusMatches = typeof expected === "string"
          ? item?.status === expected
          : expected.in.includes(item?.status as JobItemStatus);

        if (!item || !statusMatches) return { count: 0 };

        Object.assign(item, args.data);
        return { count: 1 };
      },
      findUnique: async (args: {
        where: { batchId_altCandidateId: { batchId: string; altCandidateId: string } };
        select: { status?: true; id?: true };
      }) => {
        return state.items.get(
          itemKey(
            args.where.batchId_altCandidateId.batchId,
            args.where.batchId_altCandidateId.altCandidateId,
          ),
        ) ?? null;
      },
    },
    jobBatch: {
      findUnique: async (args: { where: { id: string } }) => {
        return state.batches.get(args.where.id) ?? null;
      },
      update: async (args: {
        where: { id: string };
        data: {
          success?: { increment: number };
          failed?: { increment: number };
          skipped?: { increment: number };
        };
      }) => {
        const batch = state.batches.get(args.where.id);
        if (!batch) throw new Error("batch not found");
        batch.success += args.data.success?.increment ?? 0;
        batch.failed += args.data.failed?.increment ?? 0;
        batch.skipped += args.data.skipped?.increment ?? 0;
        return batch;
      },
      updateMany: async (args: {
        where: { id: string; status: JobBatchStatus };
        data: { status: JobBatchStatus; finishedAt: Date };
      }) => {
        const batch = state.batches.get(args.where.id);
        if (!batch || batch.status !== args.where.status) return { count: 0 };
        batch.status = args.data.status;
        batch.finishedAt = args.data.finishedAt;
        return { count: 1 };
      },
    },
    shop: {
      findUnique: async () => ({
        shopDomain: "example.myshopify.com",
        accessTokenEncrypted: encrypted.encrypted,
        accessTokenNonce: encrypted.nonce,
        accessTokenTag: encrypted.tag,
        scopes: "write_files",
      }),
    },
  };

  const client = {
    ...txClient,
    $transaction: async <T>(callback: (tx: typeof txClient) => Promise<T>) => callback(txClient),
  };

  return client as unknown as PrismaClient;
}

function createDependencies(state: MockState): WritebackProcessorDependencies {
  const prisma = createMockPrisma(state);

  return {
    prisma,
    truthCheck: async (candidate) =>
      candidate.candidateId === "c2"
        ? { isEmpty: false, currentAlt: "Manual alt" }
        : { isEmpty: true, currentAlt: null },
    getExecutor: (altPlane) => {
      assert.equal(altPlane, AltPlane.FILE_ALT);
      return new StaticExecutor(
        state.candidates.get("c3")?.status === AltCandidateStatus.GENERATED
          ? { success: false, error: "Invalid GID", retryable: true }
          : { success: true },
      );
    },
    releaseLock: async (shopId, lockId) => {
      state.releasedLocks.push(`${shopId}:${lockId}`);
    },
    now: () => new Date("2026-05-20T00:00:00.000Z"),
  };
}

async function run(): Promise<void> {
  const state = makeState();
  const dependencies = createDependencies(state);

  await processWritebackJob(makeJob("c1"), {
    ...dependencies,
    getExecutor: () => new StaticExecutor({ success: true }),
  });
  await processWritebackJob(makeJob("c2"), dependencies);
  await processWritebackJob(makeJob("c3"), dependencies);

  assert.equal(state.candidates.get("c1")?.status, AltCandidateStatus.WRITTEN);
  assert.equal(state.drafts.get("c1")?.finalText, "edited c1");
  assert.equal(state.targets.get("target-c1")?.currentAltText, "edited c1");
  assert.equal(state.auditLogs.length, 1);
  assert.equal(state.auditLogs[0].newAltText, "edited c1");
  assert.equal(state.auditLogs[0].modelUsed, "test-model");

  assert.equal(state.candidates.get("c2")?.status, AltCandidateStatus.RESOLVED);
  assert.equal(state.targets.get("target-c2")?.currentAltText, "Manual alt");
  assert.equal(state.items.get(itemKey("batch-1", "c2"))?.status, JobItemStatus.SKIPPED_ALREADY_FILLED);

  assert.equal(state.candidates.get("c3")?.status, AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE);
  assert.equal(state.candidates.get("c3")?.errorMessage, "Invalid GID");
  assert.equal(state.items.get(itemKey("batch-1", "c3"))?.status, JobItemStatus.FAILED);

  const batch = state.batches.get("batch-1");
  assert.equal(batch?.success, 1);
  assert.equal(batch?.skipped, 1);
  assert.equal(batch?.failed, 1);
  assert.equal(batch?.status, JobBatchStatus.PARTIAL_SUCCESS);
  assert.deepEqual(state.releasedLocks, ["shop-1:lock-1"]);

  console.log("✅ writeback.processor 测试全部通过");
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
