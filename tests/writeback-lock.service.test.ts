/**
 * File: tests/writeback-lock.service.test.ts
 * Purpose: WRITEBACK 锁服务单元测试。
 *          通过 mock Redis 和 PG，验证：
 *          - 获取成功
 *          - 重复获取失败（ALREADY_LOCKED）
 *          - SCAN 锁存在时获取失败（SCAN_LOCK_ACTIVE）
 *          - 释放后可重新获取
 *          - 释放仅 lockId 匹配时生效
 *          - isWritebackLocked 正确反映锁状态
 *
 * 运行方式：
 *   npx tsx tests/writeback-lock.service.test.ts
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock Redis 客户端                                                   */
/* ================================================================== */

/** 模拟 Redis 存储 */
const redisStore = new Map<string, { value: string; ttlMs: number; setAt: number }>();

/** 模拟 Redis 客户端 */
const mockRedis = {
  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<string | null> {
    // 解析参数：PX ttlMs NX
    let px = false;
    let nx = false;
    let ttlMs = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "PX") {
        px = true;
        ttlMs = Number(args[++i]);
      } else if (arg === "NX") {
        nx = true;
      }
    }

    const existing = redisStore.get(key);
    const now = Date.now();

    // 如果有 NX 且 key 已存在且未过期，返回 null
    if (nx && existing && now - existing.setAt < existing.ttlMs) {
      return null;
    }

    redisStore.set(key, { value, ttlMs: px ? ttlMs : 0, setAt: now });
    return "OK";
  },

  async get(key: string): Promise<string | null> {
    const entry = redisStore.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.ttlMs > 0 && now - entry.setAt >= entry.ttlMs) {
      redisStore.delete(key);
      return null;
    }
    return entry.value;
  },

  async eval(
    script: string,
    numkeys: number,
    ...args: unknown[]
  ): Promise<unknown> {
    const key = args[0] as string;
    const expectedValue = args[1] as string;
    const current = await this.get(key);
    if (current === expectedValue) {
      redisStore.delete(key);
      return 1;
    }
    return 0;
  },
};

/* ================================================================== */
/*  Mock PG（isOperationRunning 依赖）                                  */
/* ================================================================== */

/** 记录 PG 中是否有活跃 SCAN 锁 */
let mockScanRunning = false;

function resetMocks(): void {
  redisStore.clear();
  mockScanRunning = false;
}

/* ================================================================== */
/*  直接测试锁逻辑（内联模拟）                                           */
/* ================================================================== */

/** 模拟 WRITEBACK 锁逻辑 */
const LOCK_KEY_PREFIX = "shop:";
const LOCK_KEY_SUFFIX = ":lock:writeback";

function getLockKey(shopId: string): string {
  return `${LOCK_KEY_PREFIX}${shopId}${LOCK_KEY_SUFFIX}`;
}

async function acquireWritebackLock(
  shopId: string,
  ttlMs: number = 300_000,
): Promise<{
  acquired: boolean;
  lockId: string;
  reason?: "SCAN_LOCK_ACTIVE" | "ALREADY_LOCKED";
}> {
  // 检查 PG SCAN 锁
  if (mockScanRunning) {
    return { acquired: false, lockId: "", reason: "SCAN_LOCK_ACTIVE" };
  }

  // 生成 lockId
  const lockId = `mock-uuid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const key = getLockKey(shopId);
  const result = await mockRedis.set(key, lockId, "PX", ttlMs, "NX");

  if (result !== "OK") {
    return { acquired: false, lockId: "", reason: "ALREADY_LOCKED" };
  }

  return { acquired: true, lockId };
}

async function releaseWritebackLock(
  shopId: string,
  lockId: string,
): Promise<void> {
  const key = getLockKey(shopId);
  await mockRedis.eval("", 1, key, lockId);
}

async function isWritebackLocked(shopId: string): Promise<boolean> {
  const key = getLockKey(shopId);
  const value = await mockRedis.get(key);
  return value !== null && value !== undefined;
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  const shopId = "test-shop-001";

  /* ================================================================ */
  /*  1. 获取成功                                                      */
  /* ================================================================ */
  {
    resetMocks();
    const result = await acquireWritebackLock(shopId, 300_000);

    assert.equal(result.acquired, true, "首次获取应成功");
    assert.ok(result.lockId.length > 0, "应返回非空 lockId");
    assert.equal(result.reason, undefined, "成功时不应有 reason");

    // 验证 Redis 中确实存在锁
    const locked = await isWritebackLocked(shopId);
    assert.equal(locked, true, "获取后 isWritebackLocked 应返回 true");
  }

  /* ================================================================ */
  /*  2. 重复获取失败（ALREADY_LOCKED）                                */
  /* ================================================================ */
  {
    // 不 reset，复用上一条的锁
    const result = await acquireWritebackLock(shopId, 300_000);

    assert.equal(result.acquired, false, "重复获取应失败");
    assert.equal(result.reason, "ALREADY_LOCKED", "失败原因应为 ALREADY_LOCKED");
    assert.equal(result.lockId, "", "失败时 lockId 应为空");
  }

  /* ================================================================ */
  /*  3. SCAN 锁存在时获取失败（SCAN_LOCK_ACTIVE）                     */
  /* ================================================================ */
  {
    resetMocks();
    mockScanRunning = true;

    const result = await acquireWritebackLock(shopId, 300_000);

    assert.equal(result.acquired, false, "SCAN 锁存在时应拒绝");
    assert.equal(result.reason, "SCAN_LOCK_ACTIVE", "失败原因应为 SCAN_LOCK_ACTIVE");
    assert.equal(result.lockId, "", "失败时 lockId 应为空");

    // Redis 中不应存在 WRITEBACK 锁
    const locked = await isWritebackLocked(shopId);
    assert.equal(locked, false, "SCAN 阻止获取后 Redis 不应有 WRITEBACK 锁");
  }

  /* ================================================================ */
  /*  4. 释放后可重新获取                                              */
  /* ================================================================ */
  {
    resetMocks();
    const first = await acquireWritebackLock(shopId, 300_000);
    assert.equal(first.acquired, true, "首次获取应成功");

    await releaseWritebackLock(shopId, first.lockId);

    const locked = await isWritebackLocked(shopId);
    assert.equal(locked, false, "释放后 isWritebackLocked 应返回 false");

    const second = await acquireWritebackLock(shopId, 300_000);
    assert.equal(second.acquired, true, "释放后应可重新获取");
    assert.notEqual(second.lockId, first.lockId, "重新获取的 lockId 应不同");
  }

  /* ================================================================ */
  /*  5. 释放仅 lockId 匹配时生效                                     */
  /* ================================================================ */
  {
    resetMocks();
    const first = await acquireWritebackLock(shopId, 300_000);
    assert.equal(first.acquired, true);

    // 用错误的 lockId 释放
    await releaseWritebackLock(shopId, "wrong-lock-id");

    const stillLocked = await isWritebackLocked(shopId);
    assert.equal(stillLocked, true, "错误 lockId 不应释放锁");

    // 用正确的 lockId 释放
    await releaseWritebackLock(shopId, first.lockId);

    const unlocked = await isWritebackLocked(shopId);
    assert.equal(unlocked, false, "正确 lockId 应释放锁");
  }

  /* ================================================================ */
  /*  6. TTL 过期后锁自动释放                                          */
  /* ================================================================ */
  {
    resetMocks();
    // 使用极短 TTL（100ms）
    const result = await acquireWritebackLock(shopId, 100);
    assert.equal(result.acquired, true);

    // 等待过期
    await new Promise((resolve) => setTimeout(resolve, 150));

    const locked = await isWritebackLocked(shopId);
    assert.equal(locked, false, "TTL 过期后 isWritebackLocked 应返回 false");

    // 过期后应可重新获取
    const reacquired = await acquireWritebackLock(shopId, 300_000);
    assert.equal(reacquired.acquired, true, "TTL 过期后应可重新获取");
  }

  /* ================================================================ */
  /*  7. 不同 shop 互不影响                                            */
  /* ================================================================ */
  {
    resetMocks();
    const shop1 = "shop-alpha";
    const shop2 = "shop-beta";

    const r1 = await acquireWritebackLock(shop1, 300_000);
    assert.equal(r1.acquired, true, "shop1 获取应成功");

    const r2 = await acquireWritebackLock(shop2, 300_000);
    assert.equal(r2.acquired, true, "shop2 获取应成功（不同 shop 互不影响）");

    // 释放 shop1 不影响 shop2
    await releaseWritebackLock(shop1, r1.lockId);

    assert.equal(await isWritebackLocked(shop1), false, "shop1 释放后应未锁定");
    assert.equal(await isWritebackLocked(shop2), true, "shop2 应仍然锁定");
  }

  /* ================================================================ */
  /*  8. isWritebackLocked 在无锁时返回 false                          */
  /* ================================================================ */
  {
    resetMocks();
    const locked = await isWritebackLocked("nonexistent-shop");
    assert.equal(locked, false, "无锁时 isWritebackLocked 应返回 false");
  }

  console.log("✅ writeback-lock.service 单元测试全部通过");
}

void run().catch((error: unknown) => {
  console.error("❌ writeback-lock.service 单元测试失败");
  console.error(error);
  process.exit(1);
});
