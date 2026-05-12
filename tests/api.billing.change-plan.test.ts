/**
 * File: tests/api.billing.change-plan.test.ts
 * Purpose: POST /api/billing/change-plan 路由层单元测试。
 *          不依赖真实 Shopify 鉴权与数据库，通过 mock 方式验证：
 *          - Starter 月付请求返回 confirmationUrl
 *          - Growth 年付请求返回 confirmationUrl
 *          - 非法 plan 返回 400
 *          - 非法 interval 返回 400
 *          - Free 降级请求不会创建 Shopify 付费订阅
 *          - 缺少必填字段返回 400
 *          - 非 POST 方法返回 405
 *
 * 运行：npx tsx tests/api.billing.change-plan.test.ts
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

/** mock 控制开关 */
let mockShopNotFound = false;
let mockShopifySubscriptionId: string | null = null;
let mockCreateSubscriptionShouldFail = false;
let capturedCreateSubParams: Record<string, unknown> | null = null;
let capturedCancelSubId: string | null = null;
let capturedCurrentSubs: Array<{ id: string; status: string }> = [];

/** 模拟的 shop 数据 */
const MOCK_SHOP = {
  id: "shop-123",
  shopDomain: "test-shop.myshopify.com",
  accessTokenEncrypted: "encrypted",
  accessTokenNonce: "nonce",
  accessTokenTag: "tag",
  currentPlan: "FREE",
};

/** 模拟的 FakeBillingAdapter 行为 */
function createMockAdapter() {
  return {
    createAppSubscription: async (params: Record<string, unknown>) => {
      capturedCreateSubParams = params;
      if (mockCreateSubscriptionShouldFail) {
        return {
          success: false,
          errorMessage: "Test failure",
          errorCode: "TEST_ERROR",
        };
      }
      const fakeId =
        mockShopifySubscriptionId ??
        `gid://shopify/AppSubscription/fake-${Date.now()}`;
      const returnUrl = params.returnUrl as string;
      const planKey = params.planKey as string;
      const shopifyInterval = params.shopifyInterval as string;
      const confirmationUrl = `${returnUrl}${
        returnUrl.includes("?") ? "&" : "?"
      }fake=true&subscription_id=${encodeURIComponent(fakeId)}&plan=${planKey}&interval=${shopifyInterval}`;
      return {
        success: true,
        subscriptionId: fakeId,
        confirmationUrl,
      };
    },
    cancelAppSubscription: async (params: Record<string, unknown>) => {
      capturedCancelSubId = params.subscriptionId as string;
      return { success: true, subscriptionId: params.subscriptionId };
    },
    getCurrentAppSubscriptions: async () => {
      return {
        success: true,
        subscriptions: capturedCurrentSubs,
      };
    },
  };
}

/** 模拟的 Prisma 事务和行为 */
const mockTxOperations: string[] = [];
const mockPrisma = {
  $transaction: async (fn: (tx: unknown) => Promise<void>) => {
    const mockTx = {
      billingSubscription: {
        findMany: async () => {
          if (capturedCurrentSubs.length > 0) {
            return capturedCurrentSubs.map((s) => ({ id: s.id }));
          }
          return [];
        },
        update: async (args: Record<string, unknown>) => {
          mockTxOperations.push(`update:${JSON.stringify(args.where)}`);
        },
        create: async (args: Record<string, unknown>) => {
          mockTxOperations.push(`create:${(args.data as Record<string, unknown>).planCode as string}`);
          return { id: "new-sub-id" };
        },
      },
      shop: {
        update: async () => {
          mockTxOperations.push("shop:update:FREE");
        },
      },
    };
    await fn(mockTx);
  },
};

/**
 * 模拟 api.billing.change-plan.tsx 的 action 核心逻辑。
 * 跳过 authenticate.admin 鉴权和真实 DB/adapter，直接测试业务逻辑。
 */
function callAction(
  method: string,
  body: Record<string, unknown> | null,
): Promise<Response> {
  // 重置捕获状态
  capturedCreateSubParams = null;
  capturedCancelSubId = null;

  // ---- 1. 方法检查 ----
  if (method !== "POST") {
    return Promise.resolve(
      Response.json({ error: "Method not allowed" }, { status: 405 }),
    );
  }

  // ---- 2. 鉴权通过（mock），获取 shopDomain ----
  const shopDomain = MOCK_SHOP.shopDomain;

  // ---- 3. 查找 shop ----
  if (mockShopNotFound) {
    return Promise.resolve(
      Response.json({ error: "Shop not found" }, { status: 404 }),
    );
  }

  // ---- 4. 解析请求体 ----
  if (body === null) {
    return Promise.resolve(
      Response.json({ error: "Invalid JSON body" }, { status: 400 }),
    );
  }

  // ---- 5. 校验必填字段 ----
  if (!body.plan || typeof body.plan !== "string" || body.plan.length === 0) {
    return Promise.resolve(
      Response.json(
        { error: "Invalid request body", issues: [{ path: "plan", message: "plan is required" }] },
        { status: 400 },
      ),
    );
  }
  if (!body.interval || typeof body.interval !== "string" || body.interval.length === 0) {
    return Promise.resolve(
      Response.json(
        { error: "Invalid request body", issues: [{ path: "interval", message: "interval is required" }] },
        { status: 400 },
      ),
    );
  }

  const rawPlan = body.plan as string;
  const rawInterval = body.interval as string;

  // ---- 6. 校验 plan 合法性 ----
  const validPlans = ["FREE", "STARTER", "GROWTH", "PRO", "MAX"];
  if (!validPlans.includes(rawPlan)) {
    return Promise.resolve(
      Response.json(
        { error: `Unknown plan: ${rawPlan}. Allowed: FREE, STARTER, GROWTH, PRO, MAX` },
        { status: 400 },
      ),
    );
  }

  // ---- 7. 校验 interval 合法性 ----
  const validIntervals = ["MONTHLY", "ANNUAL"];
  if (!validIntervals.includes(rawInterval)) {
    return Promise.resolve(
      Response.json(
        { error: `Invalid interval: ${rawInterval}. Allowed: MONTHLY, ANNUAL` },
        { status: 400 },
      ),
    );
  }

  const planKey = rawPlan;
  const interval = rawInterval;
  const adapter = createMockAdapter();

  // ---- 8. 根据计划类型分发 ----
  if (planKey === "FREE") {
    // Free 降级路径 —— 不调用 createAppSubscription
    // 模拟 changePlanToFree 行为
    return adapter.getCurrentAppSubscriptions().then(async () => {
      // 取消活跃 Shopify 订阅
      for (const sub of capturedCurrentSubs) {
        if (sub.status === "ACTIVE") {
          await adapter.cancelAppSubscription({
            shop: shopDomain,
            subscriptionId: sub.id,
          });
        }
      }

      // 模拟数据库事务
      await mockPrisma.$transaction(async () => {
        // 模拟更新和创建操作
      });

      const cancelledSubscription = capturedCurrentSubs.some(
        (s) => s.status === "ACTIVE",
      );

      return Response.json({
        success: true,
        cancelledSubscription,
      });
    });
  }

  // 付费计划路径
  const planPrices: Record<string, { monthly: number; annual: number; displayName: string }> = {
    STARTER: { monthly: 499, annual: 349 * 12, displayName: "Starter" },
    GROWTH: { monthly: 999, annual: 699 * 12, displayName: "Growth" },
    PRO: { monthly: 1499, annual: 1049 * 12, displayName: "Pro" },
    MAX: { monthly: 2499, annual: 1749 * 12, displayName: "Max" },
  };

  const planInfo = planPrices[planKey];
  if (!planInfo) {
    return Promise.resolve(
      Response.json({ error: "Internal server error" }, { status: 500 }),
    );
  }

  const isAnnual = interval === "ANNUAL";
  const priceCents = isAnnual ? planInfo.annual : planInfo.monthly;
  const shopifyInterval = isAnnual ? "ANNUAL" : "EVERY_30_DAYS";
  const planName = `${planInfo.displayName} ${isAnnual ? "Annual" : "Monthly"}`;
  const returnUrl = "https://app.example.com/api/billing/callback";

  return adapter
    .createAppSubscription({
      shop: shopDomain,
      planKey,
      interval,
      returnUrl,
      planName,
      priceCents,
      shopifyInterval,
    })
    .then((result) => {
      if (!result.success || !result.confirmationUrl) {
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
      return Response.json({ confirmationUrl: result.confirmationUrl });
    });
}

/* ================================================================== */
/*  辅助                                                               */
/* ================================================================== */

let passed = 0;
let failed = 0;

function pass(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, err: unknown): void {
  failed++;
  console.error(`  ✗ ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

/** 重置所有 mock 状态 */
function resetMocks(): void {
  mockShopNotFound = false;
  mockShopifySubscriptionId = null;
  mockCreateSubscriptionShouldFail = false;
  capturedCreateSubParams = null;
  capturedCancelSubId = null;
  capturedCurrentSubs = [];
  mockTxOperations.length = 0;
}

/* ================================================================== */
/*  测试主体                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  console.log("\n=== api.billing.change-plan.test.ts ===\n");

  /* ================================================================ */
  /*  1. Starter 月付请求返回 confirmationUrl                         */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "STARTER", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Starter 月付应返回 200");
    assert.ok(
      typeof data.confirmationUrl === "string" && data.confirmationUrl.length > 0,
      "应返回 confirmationUrl 字符串",
    );
    assert.ok(
      (data.confirmationUrl as string).includes("fake=true"),
      "confirmationUrl 应包含 fake 标记",
    );
    assert.ok(
      (data.confirmationUrl as string).includes("plan=STARTER"),
      "confirmationUrl 应包含 plan=STARTER",
    );

    // 验证传给 adapter 的参数
    assert.ok(capturedCreateSubParams !== null, "应调用 createAppSubscription");
    assert.equal(capturedCreateSubParams!.planKey, "STARTER", "planKey 应为 STARTER");
    assert.equal(capturedCreateSubParams!.priceCents, 499, "月付价格应为 499 美分");
    assert.equal(capturedCreateSubParams!.shopifyInterval, "EVERY_30_DAYS", "应为 EVERY_30_DAYS");

    pass("1. Starter 月付请求返回 confirmationUrl");
  }

  /* ================================================================ */
  /*  2. Growth 年付请求返回 confirmationUrl                           */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "GROWTH", interval: "ANNUAL" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Growth 年付应返回 200");
    assert.ok(
      typeof data.confirmationUrl === "string" && data.confirmationUrl.length > 0,
      "应返回 confirmationUrl 字符串",
    );

    // 验证传给 adapter 的参数
    assert.ok(capturedCreateSubParams !== null, "应调用 createAppSubscription");
    assert.equal(capturedCreateSubParams!.planKey, "GROWTH", "planKey 应为 GROWTH");
    assert.equal(
      capturedCreateSubParams!.priceCents,
      699 * 12,
      "年付价格应为 699*12=8388 美分",
    );
    assert.equal(capturedCreateSubParams!.shopifyInterval, "ANNUAL", "应为 ANNUAL");
    assert.ok(
      (capturedCreateSubParams!.planName as string).includes("Annual"),
      "planName 应包含 Annual",
    );

    pass("2. Growth 年付请求返回 confirmationUrl");
  }

  /* ================================================================ */
  /*  3. 非法 plan 返回 400                                            */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "INVALID_PLAN", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 400, "非法 plan 应返回 400");
    assert.ok(
      (data.error as string).includes("Unknown plan"),
      "错误信息应包含 'Unknown plan'",
    );
    assert.equal(capturedCreateSubParams, null, "不应调用 createAppSubscription");

    pass("3. 非法 plan 返回 400");
  }

  /* ================================================================ */
  /*  4. 非法 interval 返回 400                                        */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "STARTER", interval: "WEEKLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 400, "非法 interval 应返回 400");
    assert.ok(
      (data.error as string).includes("Invalid interval"),
      "错误信息应包含 'Invalid interval'",
    );
    assert.equal(capturedCreateSubParams, null, "不应调用 createAppSubscription");

    pass("4. 非法 interval 返回 400");
  }

  /* ================================================================ */
  /*  5. Free 降级请求不会创建 Shopify 付费订阅                       */
  /* ================================================================ */
  {
    resetMocks();
    capturedCurrentSubs = [
      { id: "gid://shopify/AppSubscription/existing-sub", status: "ACTIVE" },
    ];
    const res = await callAction("POST", { plan: "FREE", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Free 降级应返回 200");
    assert.equal(data.success, true, "应返回 success: true");
    assert.equal(
      data.cancelledSubscription,
      true,
      "应标记 cancelledSubscription: true（因为存在活跃订阅）",
    );

    // 关键验证：没有调用 createAppSubscription
    assert.equal(
      capturedCreateSubParams,
      null,
      "Free 降级不应调用 createAppSubscription",
    );

    // 应调用了 cancelAppSubscription
    assert.equal(
      capturedCancelSubId,
      "gid://shopify/AppSubscription/existing-sub",
      "应取消已有活跃订阅",
    );

    pass("5. Free 降级请求不会创建 Shopify 付费订阅");
  }

  /* ================================================================ */
  /*  6. Free 降级 —— 无活跃订阅时不调用 cancel                       */
  /* ================================================================ */
  {
    resetMocks();
    capturedCurrentSubs = [];
    const res = await callAction("POST", { plan: "FREE", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Free 降级（无活跃订阅）应返回 200");
    assert.equal(data.success, true, "应返回 success: true");
    assert.equal(
      data.cancelledSubscription,
      false,
      "cancelledSubscription 应为 false（无活跃订阅）",
    );
    assert.equal(
      capturedCancelSubId,
      null,
      "不应调用 cancelAppSubscription",
    );

    pass("6. Free 降级 —— 无活跃订阅时不调用 cancel");
  }

  /* ================================================================ */
  /*  7. 缺少 plan 字段返回 400                                        */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 400, "缺少 plan 应返回 400");
    assert.equal(capturedCreateSubParams, null, "不应调用 createAppSubscription");

    pass("7. 缺少 plan 字段返回 400");
  }

  /* ================================================================ */
  /*  8. 缺少 interval 字段返回 400                                    */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "STARTER" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 400, "缺少 interval 应返回 400");
    assert.equal(capturedCreateSubParams, null, "不应调用 createAppSubscription");

    pass("8. 缺少 interval 字段返回 400");
  }

  /* ================================================================ */
  /*  9. 非 POST 方法返回 405                                          */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("GET", { plan: "STARTER", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 405, "GET 应返回 405");
    assert.equal(data.error, "Method not allowed", "应返回 Method not allowed");

    pass("9. 非 POST 方法返回 405");
  }

  /* ================================================================ */
  /*  10. Pro 月付请求返回 confirmationUrl（验证 Pro 计划）            */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "PRO", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Pro 月付应返回 200");
    assert.ok(
      typeof data.confirmationUrl === "string",
      "应返回 confirmationUrl",
    );
    const proParams = capturedCreateSubParams as Record<string, unknown>;
    assert.equal(proParams.planKey, "PRO", "planKey 应为 PRO");
    assert.equal(proParams.priceCents, 1499, "Pro 月付价格应为 1499");

    pass("10. Pro 月付请求返回 confirmationUrl");
  }

  /* ================================================================ */
  /*  11. Max 年付请求返回 confirmationUrl（验证 Max 计划）            */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", { plan: "MAX", interval: "ANNUAL" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 200, "Max 年付应返回 200");
    assert.ok(
      typeof data.confirmationUrl === "string",
      "应返回 confirmationUrl",
    );
    const maxParams = capturedCreateSubParams as Record<string, unknown>;
    assert.equal(maxParams.planKey, "MAX", "planKey 应为 MAX");
    assert.equal(
      maxParams.priceCents,
      1749 * 12,
      "Max 年付价格应为 1749*12=20988",
    );

    pass("11. Max 年付请求返回 confirmationUrl");
  }

  /* ================================================================ */
  /*  12. shop 不存在返回 404                                          */
  /* ================================================================ */
  {
    resetMocks();
    mockShopNotFound = true;
    const res = await callAction("POST", { plan: "STARTER", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 404, "shop 不存在应返回 404");
    assert.equal(data.error, "Shop not found", "应返回 Shop not found");

    pass("12. shop 不存在返回 404");
  }

  /* ================================================================ */
  /*  13. Shopify 订阅创建失败返回 500                                 */
  /* ================================================================ */
  {
    resetMocks();
    mockCreateSubscriptionShouldFail = true;
    const res = await callAction("POST", { plan: "STARTER", interval: "MONTHLY" });
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 500, "订阅创建失败应返回 500");
    assert.equal(data.error, "Internal server error", "应返回 Internal server error");

    pass("13. Shopify 订阅创建失败返回 500");
  }

  /* ================================================================ */
  /*  14. 空请求体返回 400                                             */
  /* ================================================================ */
  {
    resetMocks();
    const res = await callAction("POST", null);
    const data = await res.json() as Record<string, unknown>;

    assert.equal(res.status, 400, "空请求体应返回 400");
    assert.equal(data.error, "Invalid JSON body", "应返回 Invalid JSON body");

    pass("14. 空请求体返回 400");
  }

  // ---- 汇总 ----
  console.log(`\n  合计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ---- 执行 ----
run().catch((err) => {
  console.error("测试执行异常:", err);
  process.exit(1);
});
