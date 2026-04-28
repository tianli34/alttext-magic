/**
 * File: tests/parse-bulk.retry.test.ts
 * Purpose: 验证 parse_bulk_to_staging 对 Bulk URL 过期/403 的自动恢复与上限收敛。
 */
import assert from "node:assert/strict";
import { config } from "dotenv";

config();

async function run(): Promise<void> {
  const {
    processParseBulkJob,
    resetParseBulkProcessorDependenciesForTests,
    setParseBulkProcessorDependenciesForTests,
  } = await import("../worker/processors/parse-bulk.processor.js");

  try {
    {
      const attemptFailures: string[] = [];
      const taskResets: string[] = [];
      const submitCalls: string[] = [];
      let finalizeCount = 0;

      setParseBulkProcessorDependenciesForTests({
        async findAttempt() {
          return {
            id: "attempt-1",
            scanTaskId: "task-1",
            status: "READY_TO_PARSE",
            bulkResultUrl: "https://example.com/result-1.ndjson",
            attemptNo: 1,
            scanTask: {
              resourceType: "FILES",
              maxParseAttempts: 3,
              status: "RUNNING",
              successfulAttemptId: null,
            },
          };
        },
        async markAttemptParsing() {},
        async parseByResourceType() {
          throw new Error("NDJSON fetch failed: 403 Forbidden");
        },
        async countStagingRows() {
          throw new Error("此用例不应统计 staging 行数");
        },
        async markAttemptSuccess() {
          throw new Error("此用例不应成功");
        },
        async markAttemptFailed(input) {
          attemptFailures.push(input.errorMessage);
        },
        async enqueueDeriveScan() {
          throw new Error("此用例不应投递 derive");
        },
        async markScanTaskFailed() {
          throw new Error("自动恢复场景不应直接标记 task 失败");
        },
        async resetScanTaskToPendingForRetry(input) {
          taskResets.push(input.scanTaskId);
        },
        async submitTask(scanTaskId) {
          submitCalls.push(scanTaskId);
          return {
            status: "submitted",
            taskId: scanTaskId,
            attemptId: "attempt-2",
            bulkOperationId: "bulk-2",
          };
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return null;
        },
      });

      await processParseBulkJob({
        shopId: "shop-1",
        scanJobId: "scan-job-1",
        scanTaskId: "task-1",
        scanTaskAttemptId: "attempt-1",
      });

      assert.equal(attemptFailures.length, 1, "403 失败应先标记当前 attempt FAILED");
      assert.match(
        attemptFailures[0] ?? "",
        /\[BULK_URL_EXPIRED\]/,
        "403 应归类为 Bulk URL 过期/失效",
      );
      assert.deepEqual(taskResets, ["task-1"], "重试前应把 task 放回 PENDING");
      assert.deepEqual(submitCalls, ["task-1"], "应自动重新提交同一 task");
      assert.equal(finalizeCount, 0, "成功转入重试时不应提前 finalize scan_job");
    }

    resetParseBulkProcessorDependenciesForTests();

    {
      const attemptFailures: string[] = [];
      const taskFailures: string[] = [];
      let submitCount = 0;
      let finalizeCount = 0;

      setParseBulkProcessorDependenciesForTests({
        async findAttempt() {
          return {
            id: "attempt-3",
            scanTaskId: "task-2",
            status: "READY_TO_PARSE",
            bulkResultUrl: "https://example.com/result-3.ndjson",
            attemptNo: 3,
            scanTask: {
              resourceType: "PRODUCT_MEDIA",
              maxParseAttempts: 3,
              status: "RUNNING",
              successfulAttemptId: null,
            },
          };
        },
        async markAttemptParsing() {},
        async parseByResourceType() {
          throw new Error("Request timed out while downloading bulk result");
        },
        async countStagingRows() {
          throw new Error("此用例不应统计 staging 行数");
        },
        async markAttemptSuccess() {
          throw new Error("此用例不应成功");
        },
        async markAttemptFailed(input) {
          attemptFailures.push(input.errorMessage);
        },
        async enqueueDeriveScan() {
          throw new Error("此用例不应投递 derive");
        },
        async markScanTaskFailed(input) {
          taskFailures.push(input.errorMessage);
        },
        async resetScanTaskToPendingForRetry() {
          throw new Error("达到上限后不应再回到 PENDING");
        },
        async submitTask() {
          submitCount += 1;
          throw new Error("达到上限后不应再次提交");
        },
        async finalizeScanJobIfTerminal() {
          finalizeCount += 1;
          return null;
        },
      });

      await processParseBulkJob({
        shopId: "shop-2",
        scanJobId: "scan-job-2",
        scanTaskId: "task-2",
        scanTaskAttemptId: "attempt-3",
      });

      assert.equal(attemptFailures.length, 1, "达到上限时仍应记录当前 attempt 失败");
      assert.match(
        attemptFailures[0] ?? "",
        /\[BULK_DOWNLOAD_TIMEOUT\]/,
        "超时应归类为下载超时",
      );
      assert.equal(submitCount, 0, "达到上限后不能再次提交");
      assert.equal(taskFailures.length, 1, "达到上限后 task 应进入 FAILED");
      assert.match(
        taskFailures[0] ?? "",
        /\[BULK_DOWNLOAD_TIMEOUT\]/,
        "task 失败原因应保留分类信息",
      );
      assert.equal(finalizeCount, 1, "终态失败后应触发 scan_job 汇总收敛");
    }

    resetParseBulkProcessorDependenciesForTests();
    console.log("✅ parse-bulk retry 测试全部通过");
  } finally {
    resetParseBulkProcessorDependenciesForTests();

    const [{ queueConnection }, { default: prisma }] = await Promise.all([
      import("../server/queues/connection.js"),
      import("../server/db/prisma.server.js"),
    ]);
    await Promise.allSettled([queueConnection.quit(), prisma.$disconnect()]);
  }
}

void run().catch((error: unknown) => {
  console.error("❌ parse-bulk retry 测试失败");
  console.error(error);
  process.exit(1);
});
