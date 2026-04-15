"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const strict_1 = __importDefault(require("node:assert/strict"));
const dotenv_1 = require("dotenv");
(0, dotenv_1.config)();
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function ensureTestShop(prisma, shopDomain) {
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
async function cleanupTestShop(prisma, shopId, shopDomain) {
    await prisma.shopOperationLock.deleteMany({
        where: { shopId },
    });
    await prisma.shop.deleteMany({
        where: { shopDomain },
    });
}
async function run() {
    const { default: prisma } = await Promise.resolve().then(() => __importStar(require("../server/db/prisma.server.js")));
    const { acquireLock, cleanupExpiredLocks, heartbeatLock, releaseLock, } = await Promise.resolve().then(() => __importStar(require("../server/modules/lock/operation-lock.service.js")));
    const testSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shopDomain = `lock-test-${testSuffix}.myshopify.com`;
    const shopId = await ensureTestShop(prisma, shopDomain);
    try {
        const ownerScanA = { batchId: `scan-a-${testSuffix}` };
        const ownerGenerateB = { batchId: `generate-b-${testSuffix}` };
        const ownerWritebackC = { batchId: `writeback-c-${testSuffix}` };
        const ownerScanD = { batchId: `scan-d-${testSuffix}` };
        const ownerScanE = { batchId: `scan-e-${testSuffix}` };
        const ownerGenerateF = { batchId: `generate-f-${testSuffix}` };
        // 1. acquire -> 再 acquire 冲突
        const firstAcquire = await acquireLock(shopId, "SCAN", ownerScanA);
        strict_1.default.equal(firstAcquire.acquired, true, "第一次 acquire 应成功");
        strict_1.default.equal(firstAcquire.mode, "CREATED", "首次 acquire 应创建新锁");
        strict_1.default.equal(firstAcquire.lock.status, "RUNNING", "新锁状态应为 RUNNING");
        strict_1.default.equal(firstAcquire.lock.operationType, "SCAN", "锁类型应为 SCAN");
        const conflictingAcquire = await acquireLock(shopId, "GENERATE", ownerGenerateB);
        strict_1.default.equal(conflictingAcquire.acquired, false, "第二次 acquire 应冲突");
        strict_1.default.equal(conflictingAcquire.mode, "CONFLICT", "冲突结果应为 CONFLICT");
        strict_1.default.equal(conflictingAcquire.lock.batchId, ownerScanA.batchId, "冲突时应返回当前持有者 batchId");
        // 2. release 后可重新 acquire
        const releaseMismatch = await releaseLock(shopId, ownerGenerateB);
        strict_1.default.equal(releaseMismatch.released, false, "非持有者 release 不应成功");
        strict_1.default.equal(releaseMismatch.reason, "OWNER_MISMATCH", "非持有者 release 应返回 OWNER_MISMATCH");
        const released = await releaseLock(shopId, ownerScanA);
        strict_1.default.equal(released.released, true, "持有者 release 应成功");
        strict_1.default.equal(released.reason, "RELEASED", "释放结果应为 RELEASED");
        strict_1.default.equal(released.lock?.status, "RELEASED", "释放后状态应为 RELEASED");
        const reacquiredAfterRelease = await acquireLock(shopId, "GENERATE", ownerGenerateB);
        strict_1.default.equal(reacquiredAfterRelease.acquired, true, "release 后应可重新 acquire");
        strict_1.default.equal(reacquiredAfterRelease.mode, "RECLAIMED", "复用已释放记录时应为 RECLAIMED");
        strict_1.default.equal(reacquiredAfterRelease.lock.operationType, "GENERATE", "重新获取后锁类型应更新为 GENERATE");
        const releasedGenerate = await releaseLock(shopId, ownerGenerateB);
        strict_1.default.equal(releasedGenerate.released, true, "GENERATE 锁应可释放");
        // 3. heartbeat 可续租并阻止 cleanup 提前回收
        const heartbeatedAcquire = await acquireLock(shopId, "WRITEBACK", ownerWritebackC, { ttlMs: 250 });
        strict_1.default.equal(heartbeatedAcquire.acquired, true, "WRITEBACK 锁应获取成功");
        await sleep(120);
        const heartbeat = await heartbeatLock(shopId, ownerWritebackC, {
            ttlMs: 500,
        });
        strict_1.default.equal(heartbeat.heartbeated, true, "heartbeat 应成功续租");
        strict_1.default.equal(heartbeat.reason, "HEARTBEATED", "heartbeat reason 应正确");
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
        strict_1.default.equal(lockAfterHeartbeatCleanup?.status, "RUNNING", "heartbeat 后 cleanup 不应提前回收当前锁");
        strict_1.default.equal(lockAfterHeartbeatCleanup?.batchId, ownerWritebackC.batchId, "heartbeat 后 owner 不应变化");
        const blockedByHeartbeat = await acquireLock(shopId, "SCAN", ownerScanD);
        strict_1.default.equal(blockedByHeartbeat.acquired, false, "heartbeat 续租后的锁仍应拦截其他操作");
        strict_1.default.equal(blockedByHeartbeat.mode, "CONFLICT", "被续租锁拦截时应返回 CONFLICT");
        const releasedWriteback = await releaseLock(shopId, ownerWritebackC);
        strict_1.default.equal(releasedWriteback.released, true, "WRITEBACK 锁应可释放");
        // 4. 超时后 cleanup 可回收
        const expiringAcquire = await acquireLock(shopId, "SCAN", ownerScanE, {
            ttlMs: 200,
        });
        strict_1.default.equal(expiringAcquire.acquired, true, "短 TTL 锁应获取成功");
        await sleep(350);
        const cleanupResult = await cleanupExpiredLocks();
        strict_1.default.equal(cleanupResult.cleanedCount >= 1, true, "cleanup 应至少回收 1 条过期 RUNNING 锁");
        const lockAfterCleanup = await prisma.shopOperationLock.findUnique({
            where: { shopId },
            select: {
                status: true,
                batchId: true,
            },
        });
        strict_1.default.equal(lockAfterCleanup?.status, "EXPIRED", "超时 cleanup 后状态应为 EXPIRED");
        strict_1.default.equal(lockAfterCleanup?.batchId, ownerScanE.batchId, "cleanup 不应篡改原过期锁 owner");
        const reacquiredAfterCleanup = await acquireLock(shopId, "GENERATE", ownerGenerateF);
        strict_1.default.equal(reacquiredAfterCleanup.acquired, true, "cleanup 回收后应可重新 acquire");
        strict_1.default.equal(reacquiredAfterCleanup.mode, "RECLAIMED", "回收过期记录后重新获取应为 RECLAIMED");
        strict_1.default.equal(reacquiredAfterCleanup.lock.batchId, ownerGenerateF.batchId, "重新获取后 owner 应更新");
        const finalRelease = await releaseLock(shopId, ownerGenerateF);
        strict_1.default.equal(finalRelease.released, true, "最终锁应可正常释放");
        console.log("✅ operation-lock.service 集成测试全部通过");
    }
    finally {
        await cleanupTestShop(prisma, shopId, shopDomain);
        await prisma.$disconnect();
    }
}
void run().catch((error) => {
    console.error("❌ operation-lock.service 集成测试失败");
    console.error(error);
    process.exit(1);
});
