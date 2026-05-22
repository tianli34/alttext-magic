/**
 * File: tests/continuous-scan.queue.test.ts
 * Purpose: continuous-scan 队列验收测试，验证三类 Job 可成功向本地 Redis 入队并读取。
 *
 * 前置条件：本地 Redis 实例运行中（REDIS_URL 默认 redis://localhost:6379）。
 *
 * Usage: npx tsx tests/continuous-scan.queue.test.ts
 */

import { Queue } from "bullmq";
import { CONTINUOUS_SCAN_QUEUE_NAME } from "../server/config/queue-names";
import { createRedisConnection } from "../server/queues/connection";
import {
  enqueueDebounceJob,
  enqueueProductScan,
  enqueueCollectionScan,
  JOB_DEBOUNCE,
  JOB_PRODUCT,
  JOB_COLLECTION,
} from "../server/queues/continuous-scan.queue";

/** 与队列模块一致的 sanitize 函数 */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

async function runTests() {
  console.log("🧪 continuous-scan.queue 验收测试\n");

  const connection = createRedisConnection();
  const queue = new Queue(CONTINUOUS_SCAN_QUEUE_NAME, { connection });

  // 清理队列中残留 job（limit=1000 确保清空）
  await queue.drain();
  await queue.clean(0, 1000, "completed");
  await queue.clean(0, 1000, "failed");
  await queue.clean(0, 1000, "wait");
  await queue.clean(0, 1000, "delayed");

  // ---- 测试 1: 入队 debounce job ----
  console.log("\n── 测试 1: enqueueDebounceJob ──");
  {
    const data = {
      shopId: "test-shop-1",
      topic: "products/create",
      resourceId: "gid://shopify/Product/123",
      latestWebhookEventId: "wh-001",
    };
    await enqueueDebounceJob(data);
    const job = await queue.getJob(`debounce_${safe(data.shopId)}_${safe(data.topic)}_${safe(data.resourceId)}`);
    assert(job !== null, "debounce job 已创建");
    assert(job!.name === JOB_DEBOUNCE, "job name 正确");
    assert(job!.data.shopId === "test-shop-1", "shopId 正确");
    assert(job!.data.topic === "products/create", "topic 正确");
    assert(job!.data.resourceId === "gid://shopify/Product/123", "resourceId 正确");
    assert(job!.data.latestWebhookEventId === "wh-001", "latestWebhookEventId 正确");
  }

  // ---- 测试 2: 入队 product scan job ----
  console.log("\n── 测试 2: enqueueProductScan ──");
  {
    const data = {
      shopId: "test-shop-1",
      productId: "gid://shopify/Product/123",
      latestWebhookEventId: "wh-002",
    };
    await enqueueProductScan(data);
    const job = await queue.getJob(`product_${safe(data.shopId)}_${safe(data.productId)}`);
    assert(job !== null, "product scan job 已创建");
    assert(job!.name === JOB_PRODUCT, "job name 正确");
    assert(job!.data.shopId === "test-shop-1", "shopId 正确");
    assert(job!.data.productId === "gid://shopify/Product/123", "productId 正确");
    assert(job!.data.latestWebhookEventId === "wh-002", "latestWebhookEventId 正确");
  }

  // ---- 测试 3: 入队 collection scan job ----
  console.log("\n── 测试 3: enqueueCollectionScan ──");
  {
    const data = {
      shopId: "test-shop-2",
      collectionId: "gid://shopify/Collection/456",
      latestWebhookEventId: "wh-003",
    };
    await enqueueCollectionScan(data);
    const job = await queue.getJob(`collection_${safe(data.shopId)}_${safe(data.collectionId)}`);
    assert(job !== null, "collection scan job 已创建");
    assert(job!.name === JOB_COLLECTION, "job name 正确");
    assert(job!.data.shopId === "test-shop-2", "shopId 正确");
    assert(job!.data.collectionId === "gid://shopify/Collection/456", "collectionId 正确");
    assert(job!.data.latestWebhookEventId === "wh-003", "latestWebhookEventId 正确");
  }

  // ---- 测试 4: 幂等去重（相同 jobId 再次入队应覆盖） ----
  console.log("\n── 测试 4: 幂等去重 ──");
  {
    const data = {
      shopId: "test-shop-1",
      topic: "products/update",
      resourceId: "gid://shopify/Product/789",
      latestWebhookEventId: "wh-004",
    };
    await enqueueDebounceJob(data);
    // 第二次入队，使用相同 jobId（相同 shopId+topic+resourceId），但更新 latestWebhookEventId
    const data2 = { ...data, latestWebhookEventId: "wh-005" };
    await enqueueDebounceJob(data2);
    const job = await queue.getJob(`debounce_${safe(data.shopId)}_${safe(data.topic)}_${safe(data.resourceId)}`);
    assert(job !== null, "幂等重试后 job 仍存在");
    assert(job!.data.latestWebhookEventId === "wh-005", "latestWebhookEventId 已更新为最新值");
  }

  // ---- 清理 ----
  await queue.drain();
  await queue.clean(0, 0, "completed");
  await queue.clean(0, 0, "failed");
  await connection.quit();

  // ---- 结果汇总 ----
  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
  console.log(`${"=".repeat(50)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error("测试运行失败:", error);
  process.exit(1);
});
