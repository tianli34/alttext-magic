/**
 * File: tests/generate-lock.service.e2e.ts
 * Purpose: 集成测试 GENERATE 锁服务的互斥与续期逻辑。
 *
 * 验收覆盖：
 * - 获取 GENERATE 锁成功后，尝试获取 SCAN 锁 → 失败
 * - 获取 GENERATE 锁成功后，再次获取 GENERATE 锁 → 失败
 * - 释放 GENERATE 锁后，SCAN 锁可正常获取
 * - heartbeat 正确续期 TTL
 *
 * 运行方式：
 *   npx tsx tests/generate-lock.service.e2e.ts
 */
import assert from "node:assert/strict";
import { config } from "dotenv";
import type { PrismaClient } from "@prisma/client";

config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureTestShop(
  prisma: PrismaClient,
  shopDomain: string,
): Promise<string> {
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    update: {},
    create: {
      shopDomain,
      accessTokenEncrypted: "gen-lock-test",
      accessTokenNonce: "gen-lock-nonce",
      accessTokenTag: "gen-lock-tag",
      scopes: "read_products",
    },
    select: { id: true },
  });
  return shop.id;
}

async function cleanupTestShop(
  prisma: PrismaClient,
  shopId: string,
  shopDomain: string,
): Promise<void> {
  await prisma.shopOperationLock.deleteMany({
    where: { shopId },
  });
  await prisma.shop.deleteMany({
    where: { shopDomain },
  });
}

async function run(): Promise<void> {
  const { default: prisma } = await import("../server/db/prisma.server.js");
  const { acquireLock } = await import("../server/modules/lock/operation-lock.service.js");
  const {
    acquireGenerateLock,
    heartbeatGenerateLock,
    releaseGenerateLock,
  } = await import("../server/modules/lock/generate-lock.service.js");

  const testSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const shopDomain = `gen-lock-test-${testSuffix}.myshopify.com`;
  const shopId = await ensureTestShop(prisma, shopDomain);

  try {
    const batchId1 = `gen-${testSuffix}-1`;
    const batchId2 = `gen-${testSuffix}-2`;
    const scanBatchId = `scan-${testSuffix}`;

    // 1. 获取 GENERATE 锁成功后，尝试获取 SCAN 锁 → 失败
    const genAcquire1 = await acquireGenerateLock(shopId, batchId1, 10);
    assert.equal(genAcquire1.acquired, true, "应能成功获取 GENERATE 锁");

    const scanAcquireFail = await acquireLock(shopId, "SCAN", { batchId: scanBatchId });
    assert.equal(scanAcquireFail.acquired, false, "存在 GENERATE 锁时，获取 SCAN 锁应失败");
    assert.equal(scanAcquireFail.mode, "CONFLICT");

    // 2. 获取 GENERATE 锁成功后，再次获取 GENERATE 锁 (不同的 batchId) → 失败
    const genAcquireFail = await acquireGenerateLock(shopId, batchId2);
    assert.equal(genAcquireFail.acquired, false, "存在 GENERATE 锁时，另一 batch 获取 GENERATE 锁应失败");

    // 3. heartbeat 正确续期 TTL
    const beforeHeartbeat = genAcquire1.lock.expiresAt.getTime();
    await sleep(200);
    
    const heartbeatResult = await heartbeatGenerateLock(shopId, batchId1, 20);
    assert.equal(heartbeatResult.heartbeated, true, "heartbeat 应成功");
    const afterHeartbeat = heartbeatResult.lock!.expiresAt.getTime();
    assert.ok(afterHeartbeat > beforeHeartbeat, "heartbeat 后 expiresAt 应被推迟");

    // 4. 释放 GENERATE 锁后，SCAN 锁可正常获取
    const releaseResult = await releaseGenerateLock(shopId, batchId1);
    assert.equal(releaseResult.released, true, "释放 GENERATE 锁应成功");

    const scanAcquireSuccess = await acquireLock(shopId, "SCAN", { batchId: scanBatchId });
    assert.equal(scanAcquireSuccess.acquired, true, "释放 GENERATE 锁后，应能成功获取 SCAN 锁");

    // 清理 SCAN 锁
    const { releaseLock } = await import("../server/modules/lock/operation-lock.service.js");
    await releaseLock(shopId, { batchId: scanBatchId });

    console.log("✅ generate-lock.service.e2e 集成测试全部通过");
  } finally {
    await cleanupTestShop(prisma, shopId, shopDomain);
    await prisma.$disconnect();
  }
}

void run().catch((error: unknown) => {
  console.error("❌ generate-lock.service.e2e 集成测试失败");
  console.error(error);
  process.exit(1);
});
