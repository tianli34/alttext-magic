/**
 * File: tests/writeback-start.service.test.ts
 * Purpose: 写回启动服务单元测试，覆盖正常启动、锁冲突、混入无效候选、全部 decorative。
 */
import assert from "node:assert/strict";
import {
  AltCandidateStatus,
  AltPlane,
  JobBatchStatus,
  JobBatchType,
} from "@prisma/client";
import {
  startWriteback,
  WritebackStartError,
  type WritebackStartDependencies,
} from "../server/modules/writeback/writeback.service";
import type { WritebackJobData } from "../server/queues/writeback.queue";

type CandidateInput = {
  id: string;
  shopId?: string;
  status?: AltCandidateStatus;
  isDecorative?: boolean;
  hasDraft?: boolean;
  editedText?: string | null;
  generatedText?: string;
};

interface CreatedBatchInput {
  shopId: string;
  type: JobBatchType;
  status: JobBatchStatus;
  total: number;
  items: {
    create: Array<{ altCandidateId: string }>;
  };
}

function candidate(input: CandidateInput) {
  return {
    id: input.id,
    shopId: input.shopId ?? "shop-1",
    altTargetId: `target-${input.id}`,
    status: input.status ?? AltCandidateStatus.GENERATED,
    missingReason: null,
    riskFlags: [],
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenScanJobId: "scan-1",
    writtenAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    altTarget: {
      id: `target-${input.id}`,
      shopId: input.shopId ?? "shop-1",
      altPlane: AltPlane.FILE_ALT,
      writeTargetId: `gid://shopify/MediaImage/${input.id}`,
      locale: "default",
      displayTitle: null,
      displayHandle: null,
      previewUrl: null,
      currentAltText: null,
      currentAltEmpty: true,
      lastPublishedScanJobId: "scan-1",
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      presentStatus: "PRESENT",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      decorativeMark: input.isDecorative
        ? {
            id: `mark-${input.id}`,
            shopId: input.shopId ?? "shop-1",
            altTargetId: `target-${input.id}`,
            isActive: true,
            markedAt: new Date("2026-01-01T00:00:00.000Z"),
            unmarkedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        : null,
    },
    draft: input.hasDraft === false
      ? null
      : {
          id: `draft-${input.id}`,
          shopId: input.shopId ?? "shop-1",
          altCandidateId: input.id,
          batchId: null,
          modelUsed: "test-model",
          contextMode: "PRIMARY_USAGE",
          contextSnapshot: {},
          generatedText: input.generatedText ?? `generated ${input.id}`,
          editedText: input.editedText ?? null,
          finalText: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        },
  };
}

function createDependencies(
  candidates: ReturnType<typeof candidate>[],
  options?: { writebackLocked?: boolean; scanRunning?: boolean },
) {
  const enqueued: WritebackJobData[] = [];
  const createdBatches: CreatedBatchInput[] = [];

  const tx = {
    jobBatch: {
      create: async (args: { data: CreatedBatchInput; select: { id: true } }) => {
        createdBatches.push(args.data);
        return { id: "batch-1" };
      },
    },
  };

  const deps = {
    prisma: {
      altCandidate: {
        findMany: async () => candidates,
      },
      jobBatch: {
        update: async () => ({ id: "batch-1" }),
      },
      $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
    },
    isWritebackLocked: async () => options?.writebackLocked ?? false,
    isScanRunning: async () => options?.scanRunning ?? false,
    acquireWritebackLock: async () => ({ acquired: true, lockId: "lock-1" }),
    releaseWritebackLock: async () => undefined,
    enqueueWritebackJob: async (data: WritebackJobData) => {
      enqueued.push(data);
    },
  } as unknown as WritebackStartDependencies;

  return { deps, enqueued, createdBatches };
}

async function run(): Promise<void> {
  {
    const { deps, enqueued, createdBatches } = createDependencies([
      candidate({ id: "c1" }),
      candidate({ id: "c2", editedText: "edited c2" }),
      candidate({ id: "c3" }),
    ]);

    const result = await startWriteback("shop-1", ["c1", "c2", "c3"], deps);

    assert.equal(result.batchId, "batch-1");
    assert.equal(result.totalQueued, 3);
    assert.deepEqual(result.rejected, []);
    assert.equal(createdBatches.length, 1);
    assert.equal(createdBatches[0].type, JobBatchType.WRITEBACK);
    assert.equal(createdBatches[0].status, JobBatchStatus.RUNNING);
    assert.equal(createdBatches[0].total, 3);
    assert.equal(enqueued.length, 3);
    assert.equal(enqueued[1].altText, "edited c2");
    assert.equal(enqueued[0].lockId, "lock-1");
  }

  {
    const { deps } = createDependencies([candidate({ id: "c1" })], {
      writebackLocked: true,
    });

    await assert.rejects(
      () => startWriteback("shop-1", ["c1"], deps),
      (error) =>
        error instanceof WritebackStartError &&
        error.code === "WRITEBACK_LOCK_ACTIVE",
    );
  }

  {
    const { deps, enqueued } = createDependencies([
      candidate({ id: "valid" }),
      candidate({ id: "bad-status", status: AltCandidateStatus.MISSING }),
      candidate({ id: "decorative", isDecorative: true }),
      candidate({ id: "no-draft", hasDraft: false }),
    ]);

    const result = await startWriteback(
      "shop-1",
      ["valid", "bad-status", "decorative", "no-draft", "missing"],
      deps,
    );

    assert.equal(result.totalQueued, 1);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(result.rejected, [
      { candidateId: "bad-status", reason: "INVALID_STATUS" },
      { candidateId: "decorative", reason: "DECORATIVE" },
      { candidateId: "no-draft", reason: "NO_DRAFT" },
      { candidateId: "missing", reason: "NOT_FOUND" },
    ]);
  }

  {
    const { deps, enqueued } = createDependencies([
      candidate({ id: "d1", isDecorative: true }),
      candidate({ id: "d2", isDecorative: true }),
    ]);

    await assert.rejects(
      () => startWriteback("shop-1", ["d1", "d2"], deps),
      (error) => {
        assert.ok(error instanceof WritebackStartError);
        assert.equal(error.code, "NO_VALID_CANDIDATES");
        assert.deepEqual(error.rejected, [
          { candidateId: "d1", reason: "DECORATIVE" },
          { candidateId: "d2", reason: "DECORATIVE" },
        ]);
        return true;
      },
    );
    assert.equal(enqueued.length, 0);
  }

  console.log("✅ writeback-start.service 测试全部通过");
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
