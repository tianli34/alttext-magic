/**
 * File: tests/operation-lock.service.e2e.ts
 * Purpose: 集成测试 shop_operation_lock 服务的事务锁、释放、心跳与超时回收。
 *
 * 验收覆盖：
 * - acquire -> 再 acquire 冲突
 * - release 后可重新 acquire
 * - heartbeat 可续租并阻止过期回收
 * - 超时后 cleanup 可回收并重新 acquire
 *
 * 运行方式：
 *   npx tsx tests/operation-lock.service.e2e.ts
 */
import assert from "node:assert/strict";
import { config } from "dotenv";
import prisma from "../server/db/prisma.server";
config();
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function ensureTestShop(shopDomain) {
    const shop = await prisma.shop.upsert({
        where: { shopDomain },
        update: {},
        create: {
            shopDomain,
            accessTokenEncrypted: "lock-test-token",
            accessTokenNonce: "lock-test-nonce",
            accessTokenTag: "lock-test-tag",
            scopes: "read_products",
        },
        select: { id: true },
    });
    return shop.id;
}
async function cleanupTestShop(shopId, shopDomain) {
    await prisma.shopOperationLock.deleteMany({
        where: { shopId },
    });
    await prisma.shop.deleteMany({
        where: { shopDomain },
    });
}
async function run() {
    const { acquireLock, cleanupExpiredLocks, heartbeatLock, releaseLock, } = await import("../server/modules/lock/operation-lock.service.js");
    const testSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shopDomain = `lock-test-${testSuffix}.myshopify.com`;
    const shopId = await ensureTestShop(shopDomain);
    try {
        const ownerScanA = { batchId: `scan-a-${testSuffix}` };
        const ownerGenerateB = { batchId: `generate-b-${testSuffix}` };
        const ownerWritebackC = { batchId: `writeback-c-${testSuffix}` };
        const ownerScanD = { batchId: `scan-d-${testSuffix}` };
        const ownerScanE = { batchId: `scan-e-${testSuffix}` };
        const ownerGenerateF = { batchId: `generate-f-${testSuffix}` };
        // 1. acquire -> 再 acquire 冲突
        const firstAcquire = await acquireLock(shopId, "SCAN", ownerScanA);
        assert.equal(firstAcquire.acquired, true, "第一次 acquire 应成功");
        assert.equal(firstAcquire.mode, "CREATED", "首次 acquire 应创建新锁");
        assert.equal(firstAcquire.lock.status, "RUNNING", "新锁状态应为 RUNNING");
        assert.equal(firstAcquire.lock.operationType, "SCAN", "锁类型应为 SCAN");
        const conflictingAcquire = await acquireLock(shopId, "GENERATE", ownerGenerateB);
        assert.equal(conflictingAcquire.acquired, false, "第二次 acquire 应冲突");
        assert.equal(conflictingAcquire.mode, "CONFLICT", "冲突结果应为 CONFLICT");
        assert.equal(conflictingAcquire.lock.batchId, ownerScanA.batchId, "冲突时应返回当前持有者 batchId");
        // 2. release 后可重新 acquire
        const releaseMismatch = await releaseLock(shopId, ownerGenerateB);
        assert.equal(releaseMismatch.released, false, "非持有者 release 不应成功");
        assert.equal(releaseMismatch.reason, "OWNER_MISMATCH", "非持有者 release 应返回 OWNER_MISMATCH");
        const released = await releaseLock(shopId, ownerScanA);
        assert.equal(released.released, true, "持有者 release 应成功");
        assert.equal(released.reason, "RELEASED", "释放结果应为 RELEASED");
        assert.equal(released.lock?.status, "RELEASED", "释放后状态应为 RELEASED");
        const reacquiredAfterRelease = await acquireLock(shopId, "GENERATE", ownerGenerateB);
        assert.equal(reacquiredAfterRelease.acquired, true, "release 后应可重新 acquire");
        assert.equal(reacquiredAfterRelease.mode, "RECLAIMED", "复用已释放记录时应为 RECLAIMED");
        assert.equal(reacquiredAfterRelease.lock.operationType, "GENERATE", "重新获取后锁类型应更新为 GENERATE");
        const releasedGenerate = await releaseLock(shopId, ownerGenerateB);
        assert.equal(releasedGenerate.released, true, "GENERATE 锁应可释放");
        // 3. heartbeat 可续租并阻止 cleanup 提前回收
        const heartbeatedAcquire = await acquireLock(shopId, "WRITEBACK", ownerWritebackC, { ttlMs: 250 });
        assert.equal(heartbeatedAcquire.acquired, true, "WRITEBACK 锁应获取成功");
        await sleep(120);
        const heartbeat = await heartbeatLock(shopId, ownerWritebackC, {
            ttlMs: 500,
        });
        assert.equal(heartbeat.heartbeated, true, "heartbeat 应成功续租");
        assert.equal(heartbeat.reason, "HEARTBEATED", "heartbeat reason 应正确");
        await sleep(220);
        await cleanupExpiredLocks();
        const lockAfterHeartbeatCleanup = await prisma.shopOperationLock.findUnique({
            where: { shopId },
            select: {
                status: true,
                lockType: true,
                batchId: true,
            },
        });
        assert.equal(lockAfterHeartbeatCleanup?.status, "RUNNING", "heartbeat 后 cleanup 不应提前回收当前锁");
        assert.equal(lockAfterHeartbeatCleanup?.batchId, ownerWritebackC.batchId, "heartbeat 后 owner 不应变化");
        const blockedByHeartbeat = await acquireLock(shopId, "SCAN", ownerScanD);
        assert.equal(blockedByHeartbeat.acquired, false, "heartbeat 续租后的锁仍应拦截其他操作");
        assert.equal(blockedByHeartbeat.mode, "CONFLICT", "被续租锁拦截时应返回 CONFLICT");
        const releasedWriteback = await releaseLock(shopId, ownerWritebackC);
        assert.equal(releasedWriteback.released, true, "WRITEBACK 锁应可释放");
        // 4. 超时后 cleanup 可回收
        const expiringAcquire = await acquireLock(shopId, "SCAN", ownerScanE, {
            ttlMs: 200,
        });
        assert.equal(expiringAcquire.acquired, true, "短 TTL 锁应获取成功");
        await sleep(350);
        const cleanupResult = await cleanupExpiredLocks();
        assert.equal(cleanupResult.cleanedCount >= 1, true, "cleanup 应至少回收 1 条过期 RUNNING 锁");
        const lockAfterCleanup = await prisma.shopOperationLock.findUnique({
            where: { shopId },
            select: {
                status: true,
                batchId: true,
            },
        });
        assert.equal(lockAfterCleanup?.status, "EXPIRED", "超时 cleanup 后状态应为 EXPIRED");
        assert.equal(lockAfterCleanup?.batchId, ownerScanE.batchId, "cleanup 不应篡改原过期锁 owner");
        const reacquiredAfterCleanup = await acquireLock(shopId, "GENERATE", ownerGenerateF);
        assert.equal(reacquiredAfterCleanup.acquired, true, "cleanup 回收后应可重新 acquire");
        assert.equal(reacquiredAfterCleanup.mode, "RECLAIMED", "回收过期记录后重新获取应为 RECLAIMED");
        assert.equal(reacquiredAfterCleanup.lock.batchId, ownerGenerateF.batchId, "重新获取后 owner 应更新");
        const finalRelease = await releaseLock(shopId, ownerGenerateF);
        assert.equal(finalRelease.released, true, "最终锁应可正常释放");
        console.log("✅ operation-lock.service 集成测试全部通过");
    }
    finally {
        await cleanupTestShop(shopId, shopDomain);
        await prisma.$disconnect();
    }
}
void run().catch((error) => {
    console.error("❌ operation-lock.service 集成测试失败");
    console.error(error);
    process.exit(1);
});
