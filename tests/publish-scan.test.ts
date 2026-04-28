/**
 * File: tests/publish-scan.test.ts
 * Purpose: 验证 publish 关键纯逻辑：FILE_ALT 存在性重算与 candidate 收敛。
 */
import assert from "node:assert/strict";
import { config } from "dotenv";

config();

async function run(): Promise<void> {
  const [
    { computeNextCandidateState, resolveFileAltPresentStatus },
    {
      processPublishScanJob,
      resetPublishProcessorDependenciesForTests,
      setPublishProcessorDependenciesForTests,
    },
  ] =
    await Promise.all([
      import("../server/modules/scan/catalog/publish.service.js"),
      import("../worker/processors/publish-scan.processor.js"),
    ]);

  assert.equal(
    resolveFileAltPresentStatus(["NOT_FOUND", "PRESENT"]),
    "PRESENT",
    "只要 PRODUCT / FILE 任一 usage 仍为 PRESENT，FILE_ALT target 仍应保持 PRESENT",
  );
  assert.equal(
    resolveFileAltPresentStatus(["NOT_FOUND", "NOT_FOUND"]),
    "NOT_FOUND",
    "仅当两侧 usage 都不再 PRESENT 时，FILE_ALT target 才应变为 NOT_FOUND",
  );

  const now = new Date("2026-04-28T12:00:00.000Z");

  assert.deepEqual(
    computeNextCandidateState({
      now,
      target: {
        id: "target-1",
        altPlane: "FILE_ALT",
        writeTargetId: "gid://shopify/MediaImage/1",
        displayTitle: null,
        displayHandle: null,
        currentAltEmpty: true,
        presentStatus: "NOT_FOUND",
        decorativeMark: null,
        altCandidate: null,
      },
    }),
    {
      status: "NOT_FOUND",
      missingReason: null,
    },
    "已不存在的 target 应收敛为 NOT_FOUND",
  );

  assert.deepEqual(
    computeNextCandidateState({
      now,
      target: {
        id: "target-2",
        altPlane: "FILE_ALT",
        writeTargetId: "gid://shopify/MediaImage/2",
        displayTitle: null,
        displayHandle: null,
        currentAltEmpty: false,
        presentStatus: "PRESENT",
        decorativeMark: null,
        altCandidate: null,
      },
    }),
    {
      status: "RESOLVED",
      missingReason: null,
    },
    "线上 Alt 非空时应直接收敛为 RESOLVED",
  );

  assert.deepEqual(
    computeNextCandidateState({
      now,
      target: {
        id: "target-3",
        altPlane: "FILE_ALT",
        writeTargetId: "gid://shopify/MediaImage/3",
        displayTitle: null,
        displayHandle: null,
        currentAltEmpty: true,
        presentStatus: "PRESENT",
        decorativeMark: { isActive: true },
        altCandidate: null,
      },
    }),
    {
      status: "DECORATIVE_SKIPPED",
      missingReason: null,
    },
    "装饰性标记激活时应收敛为 DECORATIVE_SKIPPED",
  );

  assert.deepEqual(
    computeNextCandidateState({
      now,
      target: {
        id: "target-4",
        altPlane: "FILE_ALT",
        writeTargetId: "gid://shopify/MediaImage/4",
        displayTitle: null,
        displayHandle: null,
        currentAltEmpty: true,
        presentStatus: "PRESENT",
        decorativeMark: null,
        altCandidate: {
          id: "candidate-4",
          status: "WRITEBACK_FAILED_RETRYABLE",
          draft: {
            expiresAt: new Date("2026-04-28T13:00:00.000Z"),
          },
        },
      },
    }),
    {
      status: "WRITEBACK_FAILED_RETRYABLE",
      missingReason: null,
    },
    "存在未过期 draft 时，应保留 WRITEBACK_FAILED_RETRYABLE",
  );

  assert.deepEqual(
    computeNextCandidateState({
      now,
      target: {
        id: "target-5",
        altPlane: "FILE_ALT",
        writeTargetId: "gid://shopify/MediaImage/5",
        displayTitle: null,
        displayHandle: null,
        currentAltEmpty: true,
        presentStatus: "PRESENT",
        decorativeMark: null,
        altCandidate: {
          id: "candidate-5",
          status: "GENERATION_FAILED_RETRYABLE",
          draft: null,
        },
      },
    }),
    {
      status: "GENERATION_FAILED_RETRYABLE",
      missingReason: "EMPTY",
    },
    "无有效 draft 时，应保留 GENERATION_FAILED_RETRYABLE",
  );

  {
    const releasedLocks: string[] = [];

    setPublishProcessorDependenciesForTests({
      async publishScanResult() {
        return {
          skipped: false,
          publishedTargetCount: 2,
          publishedUsageCount: 3,
          candidateCount: 2,
          projectionCount: 2,
        };
      },
      async releaseLockByType(shopId, operationType) {
        releasedLocks.push(`${shopId}:${operationType}`);
        return {
          released: true,
          reason: "RELEASED",
          lock: null,
        };
      },
    });

    await processPublishScanJob({
      shopId: "shop-1",
      scanJobId: "scan-job-1",
    });

    assert.deepEqual(
      releasedLocks,
      ["shop-1:SCAN"],
      "publish 成功后应释放 SCAN 锁",
    );
  }

  resetPublishProcessorDependenciesForTests();

  {
    const releasedLocks: string[] = [];

    setPublishProcessorDependenciesForTests({
      async publishScanResult() {
        throw new Error("publish failed");
      },
      async releaseLockByType(shopId, operationType) {
        releasedLocks.push(`${shopId}:${operationType}`);
        return {
          released: true,
          reason: "RELEASED",
          lock: null,
        };
      },
    });

    await assert.rejects(
      processPublishScanJob({
        shopId: "shop-1",
        scanJobId: "scan-job-2",
      }),
    );

    assert.deepEqual(
      releasedLocks,
      ["shop-1:SCAN"],
      "publish 异常时也应释放 SCAN 锁，避免店铺长期卡死",
    );
  }

  resetPublishProcessorDependenciesForTests();

  console.log("✅ publish-scan 测试全部通过");
}

void run().catch((error: unknown) => {
  console.error("❌ publish-scan 测试失败");
  console.error(error);
  process.exit(1);
});
