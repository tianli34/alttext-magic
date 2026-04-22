/**
 * File: tests/bulk-operations-finish.webhook.test.ts
 * Purpose: 验证 BULK_OPERATIONS_FINISH webhook 的终态收敛、parse 投递、补位并发保护。
 */
import assert from "node:assert/strict";
import { config } from "dotenv";
import type { PendingScanTaskRow } from "../server/modules/scan/catalog/scan-task.service.js";

config();

async function run(): Promise<void> {
  const {
    handleBulkOperationsFinishWebhook,
    resetScanStartServiceDependenciesForTests,
    setScanStartServiceDependenciesForTests,
    trySubmitNextBatch,
  } = await import("../server/modules/scan/catalog/scan-start.service.js");

  try {
    {
      let markCallCount = 0;
      let parseQueueCount = 0;
      let finalizeCount = 0;

      setScanStartServiceDependenciesForTests({
        async findShopByDomain() {
          return { id: "shop-1" };
        },
        async getBulkOperationById() {
          return {
            id: "gid://shopify/BulkOperation/1",
            status: "COMPLETED",
            errorCode: null,
            url: "https://example.com/result.ndjson",
            partialDataUrl: null,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
        async markAttemptFinishedFromWebhook() {
          markCallCount += 1;
          return {
            scanJobId: "scan-job-1",
            scanTaskId: "scan-task-1",
            scanTaskAttemptId: "attempt-1",
            shopId: "shop-1",
            alreadyTerminal: markCallCount > 1,
            shouldEnqueueParse: markCallCount === 1,
          };
        },
        async enqueueParseBulkToStaging() {
          parseQueueCount += 1;
        },
        async acquireBulkSlotLock() {
          return true;
        },
        async releaseBulkSlotLock() {
          return true;
        },
        async findScanJob() {
          return { id: "scan-job-1", shopId: "shop-1" };
        },
        async getAvailableSlots() {
          return 0;
        },
        async getPendingScanTasksOrdered() {
          return [];
        },
        async submitTask() {
          throw new Error("此用例不应触发 submitTask");
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return "SUCCESS";
        },
      });

      await handleBulkOperationsFinishWebhook({
        shopDomain: "unit-test.myshopify.com",
        payload: {
          admin_graphql_api_id: "gid://shopify/BulkOperation/1",
          status: "COMPLETED",
          completed_at: new Date().toISOString(),
        },
      });

      await handleBulkOperationsFinishWebhook({
        shopDomain: "unit-test.myshopify.com",
        payload: {
          admin_graphql_api_id: "gid://shopify/BulkOperation/1",
          status: "COMPLETED",
          completed_at: new Date().toISOString(),
        },
      });

      assert.equal(parseQueueCount, 1, "重复 webhook 不应重复投递 parse job");
      assert.equal(finalizeCount, 1, "首次 webhook 应完成一次终态收敛");
      assert.equal(markCallCount, 2, "重复 webhook 仍应先查询 attempt 状态");
    }

    resetScanStartServiceDependenciesForTests();

    {
      const submittedTaskIds: string[] = [];
      const lockHolders = new Set<string>();
      let releaseCount = 0;
      let finalizeCount = 0;

      const pendingTaskRows: PendingScanTaskRow[] = [
        {
          id: "task-1",
          scanJobId: "scan-job-2",
          shopId: "shop-2",
          resourceType: "PRODUCT_MEDIA",
          currentAttemptNo: 0,
        },
        {
          id: "task-2",
          scanJobId: "scan-job-2",
          shopId: "shop-2",
          resourceType: "FILES",
          currentAttemptNo: 0,
        },
        {
          id: "task-3",
          scanJobId: "scan-job-2",
          shopId: "shop-2",
          resourceType: "COLLECTION_IMAGE",
          currentAttemptNo: 0,
        },
      ];

      setScanStartServiceDependenciesForTests({
        async findScanJob() {
          return { id: "scan-job-2", shopId: "shop-2" };
        },
        async acquireBulkSlotLock(shopId, ownerToken) {
          if (lockHolders.has(shopId)) {
            return false;
          }

          lockHolders.add(shopId);
          assert.ok(ownerToken.length > 0, "ownerToken 应存在");
          return true;
        },
        async releaseBulkSlotLock(shopId) {
          lockHolders.delete(shopId);
          releaseCount += 1;
          return true;
        },
        async getAvailableSlots() {
          return 2;
        },
        async getPendingScanTasksOrdered(_scanJobId, limit) {
          return pendingTaskRows.slice(0, limit);
        },
        async submitTask(scanTaskId) {
          submittedTaskIds.push(scanTaskId);
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });

          return {
            status: "submitted",
            taskId: scanTaskId,
            attemptId: `attempt-${scanTaskId}`,
            bulkOperationId: `bulk-${scanTaskId}`,
          };
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return "SUCCESS";
        },
      });

      const [firstResult, secondResult] = await Promise.all([
        trySubmitNextBatch("scan-job-2"),
        trySubmitNextBatch("scan-job-2"),
      ]);

      assert.deepEqual(
        submittedTaskIds.sort(),
        ["task-1", "task-2"],
        "并发补位时只能按 availableSlots 提交唯一任务",
      );
      assert.equal(releaseCount, 1, "仅实际拿到锁的调用应释放一次锁");
      assert.equal(finalizeCount, 1, "仅持锁执行者应触发一次终态收敛");
      assert.equal(firstResult?.lockAcquired ?? secondResult?.lockAcquired, true);
      assert.equal(
        [firstResult?.lockAcquired, secondResult?.lockAcquired].filter(Boolean).length,
        1,
        "并发调用中只能有一个持锁成功",
      );
    }

    resetScanStartServiceDependenciesForTests();
    console.log("✅ bulk-operations-finish webhook 测试全部通过");
  } finally {
    resetScanStartServiceDependenciesForTests();

    const [{ queueConnection }, { default: prisma }] = await Promise.all([
      import("../server/queues/connection.js"),
      import("../server/db/prisma.server.js"),
    ]);

    await Promise.allSettled([queueConnection.quit(), prisma.$disconnect()]);
  }
}

void run().catch((error: unknown) => {
  console.error("❌ bulk-operations-finish webhook 测试失败");
  console.error(error);
  process.exit(1);
});
