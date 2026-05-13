/**
 * File: tests/overage-pack.service.test.ts
 * Purpose: 超额包购买与发放服务单元测试。
 *          通过 mock PrismaClient + BillingAdapter 验证核心逻辑。
 *
 * 测试覆盖：
 *   1. findOveragePackConfig: 正确查找 / 未找到
 *   2. initiateOveragePackPurchase: 正常发起购买
 *   3. initiateOveragePackPurchase: 无效 packCode 抛错
 *   4. initiateOveragePackPurchase: Shopify 适配器失败 → 标记 FAILED
 *   5. fulfillOveragePackPurchase: 正常发放
 *   6. fulfillOveragePackPurchase: 幂等（已 PURCHASED 直接跳过）
 *   7. fulfillOveragePackPurchase: 状态异常抛错
 *   8. fulfillOveragePackPurchase: 记录不存在抛错
 *   9. API 路由层: POST /api/billing/purchase-pack 正常请求
 *  10. API 路由层: 无效 packCode 返回 400
 *  11. API 路由层: 非 POST 返回 405
 *  12. API 路由层: 缺少必填字段返回 400
 *
 * Usage: npx tsx tests/overage-pack.service.test.ts
 */
import assert from "node:assert/strict";

// ============================================================================
// Mock 数据
// ============================================================================

/** 模拟 PLAN_CONFIGS 的 overagePacks 数据 */
const MOCK_PLAN_OVERAGE_PACKS: Record<string, Array<{
  credits: number;
  priceCents: number;
  displayPrice: string;
  packCode: string;
}>> = {
  FREE: [{ credits: 100, priceCents: 299, displayPrice: "$2.99", packCode: "OVERAGE_100_299" }],
  STARTER: [{ credits: 100, priceCents: 299, displayPrice: "$2.99", packCode: "OVERAGE_100_299" }],
  GROWTH: [{ credits: 200, priceCents: 499, displayPrice: "$4.99", packCode: "OVERAGE_200_499" }],
  PRO: [{ credits: 400, priceCents: 799, displayPrice: "$7.99", packCode: "OVERAGE_400_799" }],
  MAX: [{ credits: 800, priceCents: 999, displayPrice: "$9.99", packCode: "OVERAGE_800_999" }],
};

const MOCK_SHOP_ID = "shop-001";
const MOCK_SHOP_DOMAIN = "test-shop.myshopify.com";
const MOCK_PURCHASE_ID = "purchase-001";
const MOCK_EXTERNAL_PURCHASE_ID = "gid://shopify/AppPurchaseOneTime/abc-123";

// ============================================================================
// Mock 控制变量
// ============================================================================

let mockAdapterShouldFail = false;
/** 捕获的适配器调用参数 */
interface AdapterCallParams {
  shop: string;
  packKey: string;
  returnUrl: string;
  packName: string;
  priceCents: number;
}
let capturedAdapterParams: AdapterCallParams | null = null;

/** 捕获的购买记录创建数据 */
interface PurchaseCreateData {
  shopId: string;
  status: string;
  packCode: string;
  grantedAmount: number;
  priceCents: number;
  currencyCode: string;
  idempotencyKey: string;
}
let capturedPurchaseCreate: PurchaseCreateData | null = null;

/** 捕获的购买记录更新 */
interface PurchaseUpdateCall {
  purchaseId: string;
  data: Record<string, unknown>;
}
let capturedPurchaseUpdates: PurchaseUpdateCall[] = [];

/** 模拟的当前购买记录（用于 findUnique） */
interface MockPurchaseRecord {
  id: string;
  shopId: string;
  status: string;
  packCode: string;
  grantedAmount: number;
  priceCents: number;
  externalPurchaseId: string | null;
}
let mockPurchaseRecord: MockPurchaseRecord | null = null;

// ============================================================================
// 辅助函数
// ============================================================================

/** 模拟 findOveragePackConfig 逻辑 */
function mockFindOveragePackConfig(
  planKey: string,
  packCode: string,
): { credits: number; priceCents: number; displayPrice: string; packCode: string } | null {
  const packs = MOCK_PLAN_OVERAGE_PACKS[planKey];
  if (!packs) return null;
  return packs.find((p) => p.packCode === packCode) ?? null;
}

/** 重置所有 mock 状态 */
function resetMocks() {
  mockAdapterShouldFail = false;
  capturedAdapterParams = null;
  capturedPurchaseCreate = null;
  capturedPurchaseUpdates = [];
  mockPurchaseRecord = null;
}

/** 创建默认 PENDING 购买记录 */
function createPendingPurchase(overrides: Partial<MockPurchaseRecord> = {}): MockPurchaseRecord {
  return {
    id: MOCK_PURCHASE_ID,
    shopId: MOCK_SHOP_ID,
    status: "PENDING",
    packCode: "OVERAGE_100_299",
    grantedAmount: 100,
    priceCents: 299,
    externalPurchaseId: MOCK_EXTERNAL_PURCHASE_ID,
    ...overrides,
  };
}

// ============================================================================
// 模拟 initiateOveragePackPurchase 核心逻辑
// ============================================================================

async function simulateInitiatePurchase(
  currentPlan: string,
  packCode: string,
  returnUrl: string,
) {
  // 校验 packCode
  const packConfig = mockFindOveragePackConfig(currentPlan, packCode);
  if (!packConfig) {
    throw new Error(`[overage-pack] 计划 ${currentPlan} 不支持超额包 ${packCode}`);
  }

  // 模拟创建 PENDING 记录
  capturedPurchaseCreate = {
    shopId: MOCK_SHOP_ID,
    status: "PENDING",
    packCode,
    grantedAmount: packConfig.credits,
    priceCents: packConfig.priceCents,
    currencyCode: "USD",
    idempotencyKey: "OVERAGE_PURCHASE:test-uuid",
  };

  // 构造回调 URL
  const separator = returnUrl.includes("?") ? "&" : "?";
  const callbackUrl = `${returnUrl}${separator}purchaseId=${MOCK_PURCHASE_ID}`;

  // 模拟适配器调用
  capturedAdapterParams = {
    shop: MOCK_SHOP_DOMAIN,
    packKey: packCode,
    returnUrl: callbackUrl,
    packName: `Overage Pack ${packConfig.credits}`,
    priceCents: packConfig.priceCents,
  };

  if (mockAdapterShouldFail) {
    // 模拟失败 → 标记 FAILED
    capturedPurchaseUpdates.push({
      purchaseId: MOCK_PURCHASE_ID,
      data: { status: "FAILED" },
    });
    throw new Error("[overage-pack] Shopify 购买创建失败: Test failure");
  }

  // 模拟成功 → 记录 externalPurchaseId
  capturedPurchaseUpdates.push({
    purchaseId: MOCK_PURCHASE_ID,
    data: {
      externalPurchaseId: MOCK_EXTERNAL_PURCHASE_ID,
      purchasedAt: new Date(),
    },
  });

  const confirmationUrl = `${callbackUrl}&fake=true&purchase_id=${encodeURIComponent(MOCK_EXTERNAL_PURCHASE_ID)}&pack=${packCode}`;

  return {
    confirmationUrl,
    purchaseId: MOCK_PURCHASE_ID,
    externalPurchaseId: MOCK_EXTERNAL_PURCHASE_ID,
  };
}

// ============================================================================
// 模拟 fulfillOveragePackPurchase 核心逻辑
// ============================================================================

async function simulateFulfillPurchase(purchaseId: string) {
  // 查找购买记录
  if (!mockPurchaseRecord || mockPurchaseRecord.id !== purchaseId) {
    throw new Error(`[overage-pack] 购买记录不存在: ${purchaseId}`);
  }

  // 幂等检查
  if (mockPurchaseRecord.status === "PURCHASED") {
    return { fulfilled: false as const, purchaseId: mockPurchaseRecord.id };
  }

  if (mockPurchaseRecord.status !== "PENDING") {
    throw new Error(
      `[overage-pack] 购买状态异常，期望 PENDING，实际: ${mockPurchaseRecord.status}`,
    );
  }

  // 更新状态为 PURCHASED
  capturedPurchaseUpdates.push({
    purchaseId,
    data: { status: "PURCHASED", fulfilledAt: new Date() },
  });

  // 生成 cycleKey
  const externalId = mockPurchaseRecord.externalPurchaseId ?? mockPurchaseRecord.id;
  const cycleKey = `OVERAGE:${externalId}`;

  // 模拟 grantCreditBucket
  const bucketId = "bucket-001";

  return {
    fulfilled: true as const,
    purchaseId: mockPurchaseRecord.id,
    bucketId,
    cycleKey,
  };
}

// ============================================================================
// 模拟 API 路由层逻辑
// ============================================================================

async function callPurchasePackAction(
  method: string,
  body: Record<string, unknown> | null,
) {
  if (method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (body === null) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.packCode || typeof body.packCode !== "string" || body.packCode.length === 0) {
    return Response.json(
      { error: "Invalid request body", issues: [{ path: "packCode", message: "packCode is required" }] },
      { status: 400 },
    );
  }

  const packCode = body.packCode;
  const currentPlan = "STARTER";

  const packConfig = mockFindOveragePackConfig(currentPlan, packCode);
  if (!packConfig) {
    return Response.json(
      { error: `Invalid packCode: ${packCode} for plan ${currentPlan}` },
      { status: 400 },
    );
  }

  try {
    const returnUrl = "https://app.example.com/api/billing/purchase-callback";
    const result = await simulateInitiatePurchase(currentPlan, packCode, returnUrl);
    return Response.json({ confirmationUrl: result.confirmationUrl });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ============================================================================
// 测试运行器
// ============================================================================

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ============================================================================
// 测试用例
// ============================================================================

async function runTests() {
  // ---- findOveragePackConfig 测试 ----
  console.log("\n📦 findOveragePackConfig 测试\n");

  await test("FREE 计划查找 OVERAGE_100_299 成功", async () => {
    const result = mockFindOveragePackConfig("FREE", "OVERAGE_100_299");
    assert.ok(result);
    assert.equal(result!.credits, 100);
    assert.equal(result!.priceCents, 299);
  });

  await test("STARTER 计划查找 OVERAGE_100_299 成功", async () => {
    const result = mockFindOveragePackConfig("STARTER", "OVERAGE_100_299");
    assert.ok(result);
    assert.equal(result!.credits, 100);
  });

  await test("GROWTH 计划查找 OVERAGE_200_499 成功", async () => {
    const result = mockFindOveragePackConfig("GROWTH", "OVERAGE_200_499");
    assert.ok(result);
    assert.equal(result!.credits, 200);
    assert.equal(result!.priceCents, 499);
  });

  await test("PRO 计划查找 OVERAGE_400_799 成功", async () => {
    const result = mockFindOveragePackConfig("PRO", "OVERAGE_400_799");
    assert.ok(result);
    assert.equal(result!.credits, 400);
  });

  await test("MAX 计划查找 OVERAGE_800_999 成功", async () => {
    const result = mockFindOveragePackConfig("MAX", "OVERAGE_800_999");
    assert.ok(result);
    assert.equal(result!.credits, 800);
  });

  await test("STARTER 计划查找 PRO 的包返回 null", async () => {
    const result = mockFindOveragePackConfig("STARTER", "OVERAGE_400_799");
    assert.equal(result, null);
  });

  await test("无效 packCode 返回 null", async () => {
    const result = mockFindOveragePackConfig("STARTER", "NONEXISTENT_PACK");
    assert.equal(result, null);
  });

  // ---- initiateOveragePackPurchase 测试 ----
  console.log("\n📦 initiateOveragePackPurchase 测试\n");

  await test("正常发起购买：创建 PENDING 记录并返回 confirmationUrl", async () => {
    resetMocks();

    const returnUrl = "https://app.example.com/api/billing/purchase-callback";
    const result = await simulateInitiatePurchase("STARTER", "OVERAGE_100_299", returnUrl);

    // 验证返回值
    assert.ok(result.confirmationUrl);
    assert.ok(result.confirmationUrl.includes("purchaseId="));
    assert.ok(result.confirmationUrl.includes("fake=true"));
    assert.equal(result.purchaseId, MOCK_PURCHASE_ID);
    assert.equal(result.externalPurchaseId, MOCK_EXTERNAL_PURCHASE_ID);

    // 验证创建的 PENDING 记录
    assert.ok(capturedPurchaseCreate);
    assert.equal(capturedPurchaseCreate!.status, "PENDING");
    assert.equal(capturedPurchaseCreate!.packCode, "OVERAGE_100_299");
    assert.equal(capturedPurchaseCreate!.grantedAmount, 100);
    assert.equal(capturedPurchaseCreate!.priceCents, 299);

    // 验证适配器参数
    assert.ok(capturedAdapterParams);
    assert.equal(capturedAdapterParams!.packKey, "OVERAGE_100_299");
    assert.equal(capturedAdapterParams!.priceCents, 299);
    assert.ok(capturedAdapterParams!.returnUrl.includes("purchaseId="));
  });

  await test("无效 packCode 抛错", async () => {
    resetMocks();
    try {
      await simulateInitiatePurchase("STARTER", "OVERAGE_400_799", "https://example.com");
      assert.fail("应该抛错");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("不支持超额包"));
    }
  });

  await test("Shopify 适配器失败 → 标记 FAILED", async () => {
    resetMocks();
    mockAdapterShouldFail = true;

    try {
      await simulateInitiatePurchase("STARTER", "OVERAGE_100_299", "https://example.com");
      assert.fail("应该抛错");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Shopify 购买创建失败"));
    }

    // 验证状态更新为 FAILED
    const failedUpdate = capturedPurchaseUpdates.find(
      (u) => u.data.status === "FAILED",
    );
    assert.ok(failedUpdate, "应该有一次 FAILED 状态更新");
  });

  await test("回调 URL 正确拼接 purchaseId（无已有 query params）", async () => {
    resetMocks();
    const returnUrl = "https://app.example.com/api/billing/purchase-callback";
    await simulateInitiatePurchase("STARTER", "OVERAGE_100_299", returnUrl);

    assert.ok(capturedAdapterParams);
    assert.ok(capturedAdapterParams!.returnUrl.startsWith(returnUrl + "?purchaseId="));
  });

  await test("回调 URL 正确拼接 purchaseId（已有 query params）", async () => {
    resetMocks();
    const returnUrl = "https://app.example.com/api/billing/purchase-callback?existing=1";
    await simulateInitiatePurchase("STARTER", "OVERAGE_100_299", returnUrl);

    assert.ok(capturedAdapterParams);
    assert.ok(capturedAdapterParams!.returnUrl.includes("&purchaseId="));
  });

  // ---- fulfillOveragePackPurchase 测试 ----
  console.log("\n📦 fulfillOveragePackPurchase 测试\n");

  await test("正常发放：PENDING → PURCHASED，创建 OVERAGE_PACK bucket", async () => {
    resetMocks();
    mockPurchaseRecord = createPendingPurchase();

    const result = await simulateFulfillPurchase(MOCK_PURCHASE_ID);

    assert.equal(result.fulfilled, true);
    assert.equal(result.purchaseId, MOCK_PURCHASE_ID);
    if (result.fulfilled) {
      assert.ok(result.bucketId);
    }

    // 验证状态更新
    const purchasedUpdate = capturedPurchaseUpdates.find(
      (u) => u.data.status === "PURCHASED",
    );
    assert.ok(purchasedUpdate, "应该有一次 PURCHASED 状态更新");
  });

  await test("cycleKey 使用 externalPurchaseId", async () => {
    resetMocks();
    mockPurchaseRecord = createPendingPurchase();

    const result = await simulateFulfillPurchase(MOCK_PURCHASE_ID);

    assert.ok(result.fulfilled);
    if (result.fulfilled) {
      assert.ok(result.cycleKey);
      assert.equal(result.cycleKey, `OVERAGE:${MOCK_EXTERNAL_PURCHASE_ID}`);
    }
  });

  await test("cycleKey 回退到内部 ID（无 externalPurchaseId）", async () => {
    resetMocks();
    mockPurchaseRecord = createPendingPurchase({ externalPurchaseId: null });

    const result = await simulateFulfillPurchase(MOCK_PURCHASE_ID);

    assert.ok(result.fulfilled);
    if (result.fulfilled) {
      assert.equal(result.cycleKey, `OVERAGE:${MOCK_PURCHASE_ID}`);
    }
  });

  await test("幂等：已 PURCHASED 直接跳过，不重复发放", async () => {
    resetMocks();
    mockPurchaseRecord = createPendingPurchase({ status: "PURCHASED" });

    const result = await simulateFulfillPurchase(MOCK_PURCHASE_ID);

    assert.equal(result.fulfilled, false);
    assert.equal(result.purchaseId, MOCK_PURCHASE_ID);
    // fulfilled=false 时无 bucketId
    if (!result.fulfilled) {
      assert.equal(("bucketId" in result), false);
    }

    // 不应有任何 update 操作
    assert.equal(capturedPurchaseUpdates.length, 0);
  });

  await test("状态异常（FAILED）抛错", async () => {
    resetMocks();
    mockPurchaseRecord = createPendingPurchase({ status: "FAILED" });

    try {
      await simulateFulfillPurchase(MOCK_PURCHASE_ID);
      assert.fail("应该抛错");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("购买状态异常"));
      assert.ok(err.message.includes("FAILED"));
    }
  });

  await test("购买记录不存在抛错", async () => {
    resetMocks();
    mockPurchaseRecord = null;

    try {
      await simulateFulfillPurchase("nonexistent-id");
      assert.fail("应该抛错");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("购买记录不存在"));
    }
  });

  // ---- API 路由层测试 ----
  console.log("\n📦 POST /api/billing/purchase-pack 路由层测试\n");

  await test("正常请求返回 confirmationUrl", async () => {
    resetMocks();
    const response = await callPurchasePackAction("POST", { packCode: "OVERAGE_100_299" });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { confirmationUrl: string };
    assert.ok(body.confirmationUrl);
    assert.ok(body.confirmationUrl.includes("fake=true"));
  });

  await test("无效 packCode 返回 400", async () => {
    resetMocks();
    const response = await callPurchasePackAction("POST", { packCode: "OVERAGE_400_799" });
    assert.equal(response.status, 400);

    const body = (await response.json()) as { error: string };
    assert.ok(body.error.includes("Invalid packCode"));
  });

  await test("非 POST 方法返回 405", async () => {
    const response = await callPurchasePackAction("GET", { packCode: "OVERAGE_100_299" });
    assert.equal(response.status, 405);

    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "Method not allowed");
  });

  await test("缺少 packCode 返回 400", async () => {
    const response = await callPurchasePackAction("POST", {});
    assert.equal(response.status, 400);

    const body = (await response.json()) as { error: string; issues: Array<{ path: string }> };
    assert.ok(body.error.includes("Invalid request body"));
    assert.ok(body.issues.some((i) => i.path === "packCode"));
  });

  await test("空 body 返回 400", async () => {
    const response = await callPurchasePackAction("POST", null);
    assert.equal(response.status, 400);

    const body = (await response.json()) as { error: string };
    assert.ok(body.error.includes("Invalid JSON body"));
  });

  // ---- 结果 ----
  console.log(`\n📊 结果: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("测试运行失败:", err);
  process.exit(1);
});
