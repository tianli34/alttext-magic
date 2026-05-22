/**
 * File: tests/lock-gate.test.ts
 * Purpose: lockGate 互斥锁门控单元测试。
 *          通过 mock 依赖验证：
 *          - 无锁场景：放行
 *          - 有锁场景 + 未超限：job 被延迟
 *          - 有锁场景 + 已超限：webhook_event 标记 FAILED
 *          - retry count 正确递增
 *          - checkScanLock 正确委托
 *
 * 运行方式：
 *   npx tsx tests/lock-gate.test.ts
 */

import assert from "node:assert/strict";

/* ================================================================== */
/*  导入被测函数                                                       */
/* ================================================================== */
import {
  checkScanLock,
  delayJobForLock,
  setCheckScanLockFn,
  setMarkWebhookEventFailedFn,
  resetLockGateDeps,
  DEFAULT_LOCK_GATE_DELAY_MS,
  DEFAULT_LOCK_GATE_MAX_RETRIES,
  type LockGateJobData,
} from "../server/services/gates/lockGate";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

let passed = 0;
let failed = 0;

function assertOk(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

/** 记录 mock 调用 */
interface MockCallLog {
  markFailedCalls: string[];
  moveToDelayedCalls: number[];
  updateDataCalls: LockGateJobData[];
}

/** 创建调用日志 */
function createCallLog(): MockCallLog {
  return {
    markFailedCalls: [],
    moveToDelayedCalls: [],
    updateDataCalls: [],
  };
}

/** 创建 mock Job */
function createMockJob(
  data: LockGateJobData,
  log: MockCallLog,
): {
  data: LockGateJobData;
  token: string;
  id: string;
  updateData: (newData: LockGateJobData) => Promise<void>;
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
} {
  let currentData = { ...data };

  return {
    data: currentData,
    token: "mock-token-123",
    id: "mock-job-id",

    async updateData(newData: LockGateJobData) {
      currentData = { ...newData };
      // 模拟 BullMQ 行为：updateData 后 job.data 应更新
      Object.assign(this.data, currentData);
      log.updateDataCalls.push({ ...currentData });
    },

    async moveToDelayed(timestamp: number, _token?: string) {
      log.moveToDelayedCalls.push(timestamp);
    },
  };
}

/* ================================================================== */
/*  测试                                                               */
/* ================================================================== */

async function runTests() {
  console.log("🧪 lock-gate 互斥锁门控测试\n");

  // ---- 测试 1: checkScanLock 无锁 → 返回 false ----
  console.log("\n── 测试 1: checkScanLock 无锁 → false ──");
  {
    setCheckScanLockFn(async () => false);
    const result = await checkScanLock("shop-1");
    assertOk(result === false, "无锁时 checkScanLock 返回 false");
  }

  // ---- 测试 2: checkScanLock 有锁 → 返回 true ----
  console.log("\n── 测试 2: checkScanLock 有锁 → true ──");
  {
    setCheckScanLockFn(async () => true);
    const result = await checkScanLock("shop-1");
    assertOk(result === true, "有锁时 checkScanLock 返回 true");
  }

  // ---- 测试 3: 无锁场景 → 放行 ----
  console.log("\n── 测试 3: delayJobForLock 无锁场景 → 放行 ──");
  {
    const log = createCallLog();
    setCheckScanLockFn(async () => false);
    const markFailedCalls: string[] = [];
    setMarkWebhookEventFailedFn(async (id) => { markFailedCalls.push(id); });

    const job = createMockJob(
      { shopId: "shop-1", latestWebhookEventId: "evt-1" },
      log,
    );

    const result = await delayJobForLock(job as never);

    assertOk(result.delayed === false, "无锁时 delayed=false");
    assertOk(result.exceeded === false, "无锁时 exceeded=false");
    assertOk(log.moveToDelayedCalls.length === 0, "无锁时不调用 moveToDelayed");
    assertOk(log.updateDataCalls.length === 0, "无锁时不调用 updateData");
    assertOk(markFailedCalls.length === 0, "无锁时不标记 FAILED");
  }

  // ---- 测试 4: 有锁 + 首次重试 → 延迟 ----
  console.log("\n── 测试 4: delayJobForLock 有锁首次重试 → 延迟 ──");
  {
    const log = createCallLog();
    setCheckScanLockFn(async () => true);
    setMarkWebhookEventFailedFn(async (id) => { log.markFailedCalls.push(id); });

    const job = createMockJob(
      { shopId: "shop-1", latestWebhookEventId: "evt-2" },
      log,
    );

    const result = await delayJobForLock(job as never, 5000, 3);

    assertOk(result.delayed === true, "有锁首次重试 delayed=true");
    assertOk(result.exceeded === false, "有锁首次重试 exceeded=false");
    assertOk(log.updateDataCalls.length === 1, "调用一次 updateData");
    assertOk(
      log.updateDataCalls[0]._scanLockRetryCount === 1,
      "retry count 递增为 1",
    );
    assertOk(log.moveToDelayedCalls.length === 1, "调用一次 moveToDelayed");
    assertOk(
      log.moveToDelayedCalls[0] >= Date.now() + 4000,
      "延迟时间 ≈ now + delayMs",
    );
    assertOk(log.markFailedCalls.length === 0, "未超限时不标记 FAILED");
  }

  // ---- 测试 5: 有锁 + 中间重试 → 延迟 + 计数递增 ----
  console.log("\n── 测试 5: delayJobForLock 有锁中间重试 → 计数递增 ──");
  {
    const log = createCallLog();
    setCheckScanLockFn(async () => true);
    setMarkWebhookEventFailedFn(async (id) => { log.markFailedCalls.push(id); });

    const job = createMockJob(
      {
        shopId: "shop-1",
        latestWebhookEventId: "evt-3",
        _scanLockRetryCount: 5,
      },
      log,
    );

    const result = await delayJobForLock(job as never, 30_000, 20);

    assertOk(result.delayed === true, "中间重试 delayed=true");
    assertOk(
      log.updateDataCalls[0]._scanLockRetryCount === 6,
      "retry count 从 5 递增为 6",
    );
    assertOk(log.markFailedCalls.length === 0, "未超限不标记 FAILED");
  }

  // ---- 测试 6: 有锁 + 达到上限 → 标记 FAILED ----
  console.log("\n── 测试 6: delayJobForLock 达到上限 → 标记 FAILED ──");
  {
    const log = createCallLog();
    setCheckScanLockFn(async () => true);
    setMarkWebhookEventFailedFn(async (id) => { log.markFailedCalls.push(id); });

    const job = createMockJob(
      {
        shopId: "shop-1",
        latestWebhookEventId: "evt-4",
        _scanLockRetryCount: 20,
      },
      log,
    );

    const result = await delayJobForLock(job as never, 30_000, 20);

    assertOk(result.delayed === false, "超限时 delayed=false");
    assertOk(result.exceeded === true, "超限时 exceeded=true");
    assertOk(log.markFailedCalls.length === 1, "调用一次 markFailed");
    assertOk(
      log.markFailedCalls[0] === "evt-4",
      "标记 FAILED 的 webhook_event ID 正确",
    );
    assertOk(log.moveToDelayedCalls.length === 0, "超限时不调用 moveToDelayed");
  }

  // ---- 测试 7: 有锁 + 刚好差一次超限 → 延迟（边界值） ----
  console.log("\n── 测试 7: delayJobForLock 刚好差一次超限 → 延迟 ──");
  {
    const log = createCallLog();
    setCheckScanLockFn(async () => true);
    setMarkWebhookEventFailedFn(async (id) => { log.markFailedCalls.push(id); });

    const job = createMockJob(
      {
        shopId: "shop-1",
        latestWebhookEventId: "evt-5",
        _scanLockRetryCount: 19,
      },
      log,
    );

    const result = await delayJobForLock(job as never, 30_000, 20);

    assertOk(result.delayed === true, "差一次超限时 delayed=true");
    assertOk(
      log.updateDataCalls[0]._scanLockRetryCount === 20,
      "retry count 递增为 20",
    );
    assertOk(log.markFailedCalls.length === 0, "差一次超限不标记 FAILED");
  }

  // ---- 测试 8: 默认参数值 ----
  console.log("\n── 测试 8: 默认参数值 ──");
  {
    assertOk(
      DEFAULT_LOCK_GATE_DELAY_MS === 30_000,
      "默认延迟 30000ms",
    );
    assertOk(
      DEFAULT_LOCK_GATE_MAX_RETRIES === 20,
      "默认最大重试 20 次",
    );
  }

  // ---- 测试 9: 连续重试模拟（锁在第 3 次释放） ----
  console.log("\n── 测试 9: 连续重试模拟（锁在第 3 次释放） ──");
  {
    const log = createCallLog();
    let lockPresent = true;
    setCheckScanLockFn(async () => lockPresent);
    setMarkWebhookEventFailedFn(async (id) => { log.markFailedCalls.push(id); });

    let retryCount = 0;

    // 第 1 次调用：有锁 → 延迟
    const job1 = createMockJob(
      { shopId: "shop-1", latestWebhookEventId: "evt-6", _scanLockRetryCount: retryCount },
      log,
    );
    const result1 = await delayJobForLock(job1 as never, 1000, 10);
    assertOk(result1.delayed === true, "第 1 次：延迟");
    retryCount = log.updateDataCalls[log.updateDataCalls.length - 1]._scanLockRetryCount ?? 0;

    // 第 2 次调用：仍有锁 → 延迟
    const job2 = createMockJob(
      { shopId: "shop-1", latestWebhookEventId: "evt-6", _scanLockRetryCount: retryCount },
      log,
    );
    const result2 = await delayJobForLock(job2 as never, 1000, 10);
    assertOk(result2.delayed === true, "第 2 次：延迟");
    retryCount = log.updateDataCalls[log.updateDataCalls.length - 1]._scanLockRetryCount ?? 0;

    // 锁释放
    lockPresent = false;

    // 第 3 次调用：无锁 → 放行
    const job3 = createMockJob(
      { shopId: "shop-1", latestWebhookEventId: "evt-6", _scanLockRetryCount: retryCount },
      log,
    );
    const result3 = await delayJobForLock(job3 as never, 1000, 10);
    assertOk(result3.delayed === false, "第 3 次：放行");
    assertOk(result3.exceeded === false, "第 3 次：未超限");

    assertOk(log.moveToDelayedCalls.length === 2, "总共延迟 2 次");
    assertOk(log.markFailedCalls.length === 0, "未标记 FAILED");
  }

  // ---- 测试 10: resetLockGateDeps 恢复默认 ----
  console.log("\n── 测试 10: resetLockGateDeps ──");
  {
    setCheckScanLockFn(async () => true);
    resetLockGateDeps();
    // 验证不会抛错（即依赖已恢复为默认实现）
    assertOk(true, "resetLockGateDeps 不抛错");
  }

  // ---- 清理 ----
  resetLockGateDeps();

  // ---- 汇总 ----
  console.log(`\n📊 测试结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("测试运行失败:", err);
  process.exit(1);
});
