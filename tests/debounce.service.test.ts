/**
 * File: tests/debounce.service.test.ts
 * Purpose: debounce 服务单元测试。通过 mock Redis 验证：
 *          - key 格式正确
 *          - tryAcquire NX 抢占成功/失败
 *          - update 覆盖 value 并刷新 TTL
 *          - consume GETDEL 原子性（读取+删除）
 *          - TTL 过期后重新抢占
 *          - 不同资源互不干扰
 *
 * 运行方式：
 *   npx tsx tests/debounce.service.test.ts
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  导入被测函数                                                       */
/* ================================================================== */
import {
  key,
  tryAcquire,
  update,
  consume,
  setDebounceRedis,
  resetDebounceRedis,
} from "../server/modules/scan/continuous/debounce.service";

/* ================================================================== */
/*  Mock Redis 客户端                                                  */
/* ================================================================== */

interface StoreEntry {
  value: string;
  ttlMs: number;
  setAt: number;
}

const redisStore = new Map<string, StoreEntry>();

const mockRedis = {
  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<string | null> {
    let ex = false;
    let nx = false;
    let ttlMs = 0;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "EX") {
        ex = true;
        ttlMs = Number(args[++i]) * 1000;
      } else if (args[i] === "NX") {
        nx = true;
      }
    }

    const existing = redisStore.get(key);
    const now = Date.now();

    if (nx && existing && now - existing.setAt < existing.ttlMs) {
      return null;
    }

    redisStore.set(key, { value, ttlMs: ex ? ttlMs : 0, setAt: now });
    return "OK";
  },

  async get(key: string): Promise<string | null> {
    const entry = redisStore.get(key);
    if (!entry) return null;
    if (entry.ttlMs > 0 && Date.now() - entry.setAt >= entry.ttlMs) {
      redisStore.delete(key);
      return null;
    }
    return entry.value;
  },

  async getdel(key: string): Promise<string | null> {
    const entry = redisStore.get(key);
    if (!entry) return null;
    if (entry.ttlMs > 0 && Date.now() - entry.setAt >= entry.ttlMs) {
      redisStore.delete(key);
      return null;
    }
    const value = entry.value;
    redisStore.delete(key);
    return value;
  },
};

function resetMocks(): void {
  redisStore.clear();
  setDebounceRedis(mockRedis);
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  const shopId = "test-shop-1";
  const topic = "products/create";
  const resourceId = "gid://shopify/Product/123";
  const wh1 = "webhook-event-001";
  const wh2 = "webhook-event-002";
  const defaultTtl = 60;

  /* ================================================================ */
  /*  1. key 格式正确                                                  */
  /* ================================================================ */
  {
    const k = key(shopId, topic, resourceId);
    assert.equal(
      k,
      `debounce:${shopId}:${topic}:${resourceId}`,
      "key 格式应为 debounce:{shopId}:{topic}:{resourceId}",
    );
    assert.ok(k.startsWith("debounce:"), "key 应以 debounce: 开头");
    assert.ok(k.includes(shopId), "key 应包含 shopId");
    assert.ok(k.includes(topic), "key 应包含 topic");
    assert.ok(k.includes(resourceId), "key 应包含 resourceId");
  }

  /* ================================================================ */
  /*  2. tryAcquire 首次成功                                           */
  /* ================================================================ */
  {
    resetMocks();
    const result = await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);

    assert.equal(result.acquired, true, "首次 tryAcquire 应成功");
    assert.equal(
      result.previousWebhookEventId,
      undefined,
      "成功时不应有 previousWebhookEventId",
    );
  }

  /* ================================================================ */
  /*  3. tryAcquire 重复抢占失败，返回已有值                            */
  /* ================================================================ */
  {
    // 不 reset，复用上一条的 key
    const result = await tryAcquire(shopId, topic, resourceId, wh2, defaultTtl);

    assert.equal(result.acquired, false, "重复 tryAcquire 应失败");
    assert.equal(
      result.previousWebhookEventId,
      wh1,
      "失败时应返回已有的 webhookEventId",
    );
  }

  /* ================================================================ */
  /*  4. update 覆盖 value 并刷新 TTL                                  */
  /* ================================================================ */
  {
    resetMocks();
    // 先写入
    await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);

    // 用 update 覆盖
    await update(shopId, topic, resourceId, wh2, defaultTtl);

    // 验证 value 已更新
    const entry = redisStore.get(key(shopId, topic, resourceId));
    assert.equal(entry?.value, wh2, "update 后 value 应为新值");
  }

  /* ================================================================ */
  /*  5. consume 读取并删除 key                                        */
  /* ================================================================ */
  {
    resetMocks();
    await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);

    const value = await consume(shopId, topic, resourceId);

    assert.equal(value, wh1, "consume 应返回 webhookEventId");

    // 验证 key 已被删除
    const after = await mockRedis.get(key(shopId, topic, resourceId));
    assert.equal(after, null, "consume 后 key 应被删除");
  }

  /* ================================================================ */
  /*  6. consume 不存在的 key 返回 null                                */
  /* ================================================================ */
  {
    resetMocks();
    const value = await consume(shopId, topic, resourceId);

    assert.equal(value, null, "key 不存在时 consume 应返回 null");
  }

  /* ================================================================ */
  /*  7. consume 后可重新 tryAcquire                                    */
  /* ================================================================ */
  {
    resetMocks();
    const first = await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);
    assert.equal(first.acquired, true, "首次获取应成功");

    await consume(shopId, topic, resourceId);

    const second = await tryAcquire(shopId, topic, resourceId, wh2, defaultTtl);
    assert.equal(second.acquired, true, "consume 后可重新获取");
    assert.equal(
      second.previousWebhookEventId,
      undefined,
      "重新获取成功不应有 previousWebhookEventId",
    );
  }

  /* ================================================================ */
  /*  8. TTL 过期后重新抢占成功                                        */
  /* ================================================================ */
  {
    resetMocks();

    // 写入一个极短 TTL 的 key
    const k = key(shopId, topic, resourceId);
    await mockRedis.set(k, wh1, "EX", 0); // 0 秒 TTL → 立即过期

    // 等 10ms 确保过期
    await new Promise((r) => setTimeout(r, 10));

    // 此时 tryAcquire 应成功
    const result = await tryAcquire(shopId, topic, resourceId, wh2, defaultTtl);
    assert.equal(result.acquired, true, "TTL 过期后 tryAcquire 应成功");
  }

  /* ================================================================ */
  /*  9. 不同资源互不干扰                                              */
  /* ================================================================ */
  {
    resetMocks();
    const topic2 = "products/update";
    const resourceId2 = "gid://shopify/Product/456";

    const r1 = await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);
    assert.equal(r1.acquired, true);

    const r2 = await tryAcquire(shopId, topic2, resourceId2, wh2, defaultTtl);
    assert.equal(r2.acquired, true, "不同 (topic, resourceId) 应互不干扰");

    // consume 第一个不影响第二个
    const consumed1 = await consume(shopId, topic, resourceId);
    assert.equal(consumed1, wh1);

    const consumed2 = await consume(shopId, topic2, resourceId2);
    assert.equal(consumed2, wh2, "第二个资源应仍可正常 consume");
  }

  /* ================================================================ */
  /*  10. update 在 key 不存在时也能创建                                */
  /* ================================================================ */
  {
    resetMocks();
    await update(shopId, topic, resourceId, wh1, defaultTtl);

    const entry = redisStore.get(key(shopId, topic, resourceId));
    assert.equal(entry?.value, wh1, "update 在 key 不存在时应创建新 key");
  }

  /* ================================================================ */
  /*  11. consume 返回 update 后的最新值                               */
  /* ================================================================ */
  {
    resetMocks();
    await tryAcquire(shopId, topic, resourceId, wh1, defaultTtl);
    await update(shopId, topic, resourceId, wh2, defaultTtl);

    const consumed = await consume(shopId, topic, resourceId);
    assert.equal(
      consumed,
      wh2,
      "consume 应返回 update 覆盖后的最新值",
    );
  }

  console.log("✅ debounce.service 单元测试全部通过");
}

void run().catch((error: unknown) => {
  console.error("❌ debounce.service 单元测试失败");
  console.error(error);
  process.exit(1);
});
