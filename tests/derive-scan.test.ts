/**
 * File: tests/derive-scan.test.ts
 * Purpose: 验证 derive 对 FILE_ALT 去重、usage 保留与重复执行稳定性。
 */
import assert from "node:assert/strict";
import { config } from "dotenv";

config();

async function run(): Promise<void> {
  const [
    deriveService,
    deriveProcessor,
    parseProcessor,
    { queueConnection },
    { default: prisma },
  ] = await Promise.all([
    import("../server/modules/scan/catalog/derive.service.js"),
    import("../worker/processors/derive-scan.processor.js"),
    import("../worker/processors/parse-bulk.processor.js"),
    import("../server/queues/connection.js"),
    import("../server/db/prisma.server.js"),
  ]);

  const {
    deriveFileResults,
    deriveProductMediaResults,
    resetDerivePersistenceForTests,
    setDerivePersistenceForTests,
  } = deriveService;
  const {
    processDeriveScanJob,
    resetDeriveProcessorDependenciesForTests,
    setDeriveProcessorDependenciesForTests,
  } = deriveProcessor;
  const {
    processParseBulkJob,
    resetParseBulkProcessorDependenciesForTests,
    setParseBulkProcessorDependenciesForTests,
  } = parseProcessor;

  try {
    {
      const productResult = deriveProductMediaResults({
        shopId: "shop-1",
        scanJobId: "scan-job-1",
        products: [
          {
            productId: "gid://shopify/Product/1",
            title: "Product A",
            handle: "product-a",
          },
        ],
        mediaRows: [
          {
            mediaImageId: "gid://shopify/MediaImage/1",
            parentProductId: "gid://shopify/Product/1",
            alt: "product alt",
            url: "https://cdn.example.com/product-1.jpg",
            positionIndex: 0,
          },
        ],
        existingTargets: [],
      });
      const canonicalResourceType = productResult.targets[0]?.resourceType;

      assert.equal(productResult.targets.length, 1, "产品媒体应只产出 1 条 FILE_ALT target");
      assert.equal(canonicalResourceType, "PRODUCT_MEDIA");
      assert.equal(productResult.usages.length, 1, "产品媒体应产出 1 条 PRODUCT usage");

      const fileResult = deriveFileResults({
        shopId: "shop-1",
        scanJobId: "scan-job-1",
        rows: [
          {
            mediaImageId: "gid://shopify/MediaImage/1",
            alt: "file alt",
            url: "https://cdn.example.com/file-1.jpg",
          },
        ],
        existingTargets: [
          {
            resourceType: canonicalResourceType ?? "PRODUCT_MEDIA",
            writeTargetId: "gid://shopify/MediaImage/1",
            currentAltText: "product alt",
            previewUrl: "https://cdn.example.com/product-1.jpg",
            displayTitle: "Product A",
            displayHandle: "product-a",
          },
        ],
      });

      assert.equal(
        fileResult.targets.length,
        1,
        "同一 MediaImage 即使来自 FILES，也只能继续复用已有 target",
      );
      assert.equal(
        fileResult.targets[0]?.resourceType,
        "PRODUCT_MEDIA",
        "FILES 应复用已存在 target 的 canonical resourceType，避免双 target",
      );
      assert.equal(fileResult.usages.length, 1, "FILES 仍应保留自己的 FILE usage");
      assert.equal(fileResult.usages[0]?.usageType, "FILE");
      assert.equal(fileResult.warnings.length, 2, "alt/url 同时冲突时应记录两条告警");

      const combinedTargets = new Map<string, string>();
      for (const target of [...productResult.targets, ...fileResult.targets]) {
        combinedTargets.set(target.writeTargetId, target.resourceType);
      }
      assert.equal(
        combinedTargets.size,
        1,
        "PRODUCT_MEDIA + FILES 汇总后仍应只有 1 个 FILE_ALT target",
      );
      assert.equal(
        productResult.usages.length + fileResult.usages.length,
        2,
        "usage 应同时保留 PRODUCT + FILE 两条",
      );
    }

    {
      const persistedTargets: string[] = [];
      const persistedUsages: string[] = [];

      setDerivePersistenceForTests({
        async findAttemptContext() {
          return {
            id: "attempt-1",
            shopId: "shop-1",
            scanTaskId: "task-1",
            attemptNo: 1,
            status: "SUCCESS",
            scanTask: {
              id: "task-1",
              shopId: "shop-1",
              scanJobId: "scan-job-1",
              resourceType: "FILES",
              currentAttemptNo: 1,
              status: "RUNNING",
              successfulAttemptId: null,
            },
          };
        },
        async loadFileStaging() {
          return [
            {
              mediaImageId: "gid://shopify/MediaImage/1",
              alt: "same alt",
              url: "https://cdn.example.com/file-1.jpg",
            },
          ];
        },
        async loadExistingFileAltTargets() {
          return [];
        },
        async persistDerivedResults(result) {
          for (const target of result.targets) {
            persistedTargets.push(
              [
                target.resourceType,
                target.altPlane,
                target.writeTargetId,
                target.currentAltText ?? "",
              ].join("::"),
            );
          }
          for (const usage of result.usages) {
            persistedUsages.push(
              [
                usage.resourceType,
                usage.altPlane,
                usage.writeTargetId,
                usage.usageType,
                usage.usageId,
              ].join("::"),
            );
          }
        },
      });

      await deriveService.deriveAndPersistScanResults({
        scanTaskAttemptId: "attempt-1",
      });
      await deriveService.deriveAndPersistScanResults({
        scanTaskAttemptId: "attempt-1",
      });

      assert.deepEqual(
        persistedTargets,
        [
          "FILES::FILE_ALT::gid://shopify/MediaImage/1::same alt",
          "FILES::FILE_ALT::gid://shopify/MediaImage/1::same alt",
        ],
        "重复 derive 应生成相同 target payload，便于上层 upsert 保持稳定",
      );
      assert.deepEqual(
        persistedUsages,
        [
          "FILES::FILE_ALT::gid://shopify/MediaImage/1::FILE::gid://shopify/MediaImage/1",
          "FILES::FILE_ALT::gid://shopify/MediaImage/1::FILE::gid://shopify/MediaImage/1",
        ],
        "重复 derive 应生成相同 usage payload，便于上层 upsert 保持稳定",
      );
    }

    resetDerivePersistenceForTests();

    {
      const taskSuccesses: string[] = [];
      let finalizeCount = 0;

      setDeriveProcessorDependenciesForTests({
        async deriveAndPersistScanResults() {
          return {
            skipped: false,
            resourceType: "FILES",
            targetCount: 1,
            usageCount: 1,
            warnings: [],
          };
        },
        async markScanTaskSucceeded(input) {
          taskSuccesses.push(input.scanTaskAttemptId);
        },
        async markScanTaskFailed() {
          throw new Error("此用例不应标记 task 失败");
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return null;
        },
        async getTaskSuccessfulAttemptId() {
          return null;
        },
        async releaseLockByType() {
          throw new Error("此用例不应释放锁");
        },
      });

      await processDeriveScanJob({
        shopId: "shop-1",
        scanJobId: "scan-job-1",
        scanTaskId: "task-1",
        scanTaskAttemptId: "attempt-1",
      });

      assert.deepEqual(
        taskSuccesses,
        ["attempt-1"],
        "derive 成功后才应把 task 标记为 SUCCESS",
      );
      assert.equal(finalizeCount, 1, "derive 成功后应触发 scan_job 汇总收敛");
    }

    resetDeriveProcessorDependenciesForTests();

    {
      const releasedLocks: string[] = [];
      let enqueueCount = 0;

      setDeriveProcessorDependenciesForTests({
        async deriveAndPersistScanResults() {
          throw new Error("derive failed");
        },
        async markScanTaskSucceeded() {
          throw new Error("失败用例不应标记成功");
        },
        async markScanTaskFailed() {
          return;
        },
        async finalizeScanJobIfTerminal() {
          return {
            status: "FAILED",
            transitioned: true,
          };
        },
        async enqueuePublishScanResult() {
          enqueueCount += 1;
        },
        async getTaskSuccessfulAttemptId() {
          return null;
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
        processDeriveScanJob({
          shopId: "shop-1",
          scanJobId: "scan-job-1",
          scanTaskId: "task-3",
          scanTaskAttemptId: "attempt-3",
        }),
      );

      assert.deepEqual(
        releasedLocks,
        ["shop-1:SCAN"],
        "scan_job 收敛为 FAILED 时应立即释放 SCAN 锁",
      );
      assert.equal(enqueueCount, 0, "FAILED 不应再投递 publish");
    }

    resetDeriveProcessorDependenciesForTests();

    {
      const deriveEnqueues: string[] = [];
      let finalizeCount = 0;

      setParseBulkProcessorDependenciesForTests({
        async findAttempt() {
          return {
            id: "attempt-2",
            scanTaskId: "task-2",
            status: "SUCCESS",
            bulkResultUrl: "https://example.com/result-2.ndjson",
            attemptNo: 1,
            scanTask: {
              resourceType: "FILES",
              maxParseAttempts: 3,
              status: "RUNNING",
              successfulAttemptId: null,
            },
          };
        },
        async markAttemptParsing() {
          throw new Error("成功重试补投 derive 时不应重新进入 PARSING");
        },
        async parseByResourceType() {
          throw new Error("成功重试补投 derive 时不应重新解析 NDJSON");
        },
        async countStagingRows() {
          throw new Error("成功重试补投 derive 时不应重新统计 staging");
        },
        async markAttemptSuccess() {
          throw new Error("成功重试补投 derive 时不应再次更新 attempt");
        },
        async markAttemptFailed() {
          throw new Error("成功重试补投 derive 时不应把 attempt 改回失败");
        },
        async enqueueDeriveScan(data) {
          deriveEnqueues.push(data.scanTaskAttemptId);
        },
        async markScanTaskFailed() {
          throw new Error("成功重试补投 derive 时不应标记 task 失败");
        },
        async resetScanTaskToPendingForRetry() {
          throw new Error("成功重试补投 derive 时不应重置 task");
        },
        async submitTask() {
          throw new Error("成功重试补投 derive 时不应重新提交 bulk");
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return null;
        },
      });

      await processParseBulkJob({
        shopId: "shop-1",
        scanJobId: "scan-job-1",
        scanTaskId: "task-2",
        scanTaskAttemptId: "attempt-2",
      });

      assert.deepEqual(
        deriveEnqueues,
        ["attempt-2"],
        "当 parse 已成功但 derive 未落下时，重试应补投 derive",
      );
      assert.equal(finalizeCount, 0, "补投 derive 前不应提前 finalize scan_job");
    }

    resetParseBulkProcessorDependenciesForTests();
    console.log("✅ derive-scan 测试全部通过");
  } finally {
    resetDerivePersistenceForTests();
    resetDeriveProcessorDependenciesForTests();
    resetParseBulkProcessorDependenciesForTests();
    await Promise.allSettled([queueConnection.quit(), prisma.$disconnect()]);
  }
}

void run().catch((error: unknown) => {
  console.error("❌ derive-scan 测试失败");
  console.error(error);
  process.exit(1);
});
