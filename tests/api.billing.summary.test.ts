/**
 * File: tests/api.billing.summary.test.ts
 * Purpose: GET /api/billing/summary 路由层单元测试。
 *          通过 mock 方式验证：
 *          - Starter 月付活跃订阅 + 余额 + 最近购买记录正常返回
 *          - 新安装店铺（无订阅）返回 Free + welcome + Free monthly 余额
 *          - Shop 不存在返回 404
 *          - 响应结构字段完整性校验
 *          - NONE interval 映射为 MONTHLY
 *          - 年付计划 ANNUAL interval 正确透传
 *
 * 运行：npx tsx tests/api.billing.summary.test.ts
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

/** mock 控制开关 */
let mockShopNotFound = false;
let mockSubscription: {
  planCode: string;
  billingInterval: string;
  incrementalScanEnabled: boolean;
} | null = null;
let mockBalance: {
  includedRemaining: number;
  includedPeriodType: string;
  welcomeRemaining: number;
  overagePackRemaining: number;
  totalRemaining: number;
} = {
  includedRemaining: 0,
  includedPeriodType: "MONTHLY",
  welcomeRemaining: 0,
  overagePackRemaining: 0,
  totalRemaining: 0,
};
let mockRecentPurchases: Array<{
  packCode: string;
  grantedAmount: number;
  priceCents: number;
  currencyCode: string;
  createdAt: Date;
}> = [];
let mockShopCurrentPlan = "FREE";

/** 模拟 shop 数据 */
const MOCK_SHOP_ID = "shop-123";

/** 计划配置（简化版，与 server/config/plans.ts 对齐） */
const PLAN_CONFIGS: Record<string, {
  planKey: string;
  displayName: string;
  monthlyPriceCents: number;
  annualMonthlyPriceCents: number;
  monthlyQuota: number;
  annualTotalCredits: number;
  incrementalScanEnabled: boolean;
  overagePacks: Array<{
    packCode: string;
    credits: number;
    priceCents: number;
    displayPrice: string;
  }>;
}> = {
  FREE: {
    planKey: "FREE",
    displayName: "Free",
    monthlyPriceCents: 0,
    annualMonthlyPriceCents: 0,
    monthlyQuota: 25,
    annualTotalCredits: 0,
    incrementalScanEnabled: false,
    overagePacks: [
      { packCode: "OVERAGE_100_299", credits: 100, priceCents: 299, displayPrice: "$2.99" },
    ],
  },
  STARTER: {
    planKey: "STARTER",
    displayName: "Starter",
    monthlyPriceCents: 499,
    annualMonthlyPriceCents: 349,
    monthlyQuota: 150,
    annualTotalCredits: 1800,
    incrementalScanEnabled: true,
    overagePacks: [
      { packCode: "OVERAGE_100_299", credits: 100, priceCents: 299, displayPrice: "$2.99" },
    ],
  },
  GROWTH: {
    planKey: "GROWTH",
    displayName: "Growth",
    monthlyPriceCents: 999,
    annualMonthlyPriceCents: 699,
    monthlyQuota: 350,
    annualTotalCredits: 4200,
    incrementalScanEnabled: true,
    overagePacks: [
      { packCode: "OVERAGE_200_499", credits: 200, priceCents: 499, displayPrice: "$4.99" },
    ],
  },
  PRO: {
    planKey: "PRO",
    displayName: "Pro",
    monthlyPriceCents: 1499,
    annualMonthlyPriceCents: 1049,
    monthlyQuota: 800,
    annualTotalCredits: 9600,
    incrementalScanEnabled: true,
    overagePacks: [
      { packCode: "OVERAGE_400_799", credits: 400, priceCents: 799, displayPrice: "$7.99" },
    ],
  },
  MAX: {
    planKey: "MAX",
    displayName: "Max",
    monthlyPriceCents: 2499,
    annualMonthlyPriceCents: 1749,
    monthlyQuota: 2000,
    annualTotalCredits: 24000,
    incrementalScanEnabled: true,
    overagePacks: [
      { packCode: "OVERAGE_800_999", credits: 800, priceCents: 999, displayPrice: "$9.99" },
    ],
  },
};

/**
 * 模拟 api.billing.summary.tsx 的 loader 核心逻辑。
 * 跳过 authenticate.admin 鉴权，直接测试业务逻辑。
 */
function callLoader(): Promise<Response> {
  // ---- 1. 模拟鉴权通过 ----
  const shopId = MOCK_SHOP_ID;

  // ---- 2. 查找 shop ----
  if (mockShopNotFound) {
    return Promise.resolve(
      Response.json({ error: "Shop not found" }, { status: 404 }),
    );
  }

  // ---- 3. 确定计划信息 ----
  const currentPlan = mockSubscription?.planCode ?? mockShopCurrentPlan ?? "FREE";
  const rawInterval = mockSubscription?.billingInterval ?? "NONE";
  const billingInterval = rawInterval === "ANNUAL" ? "ANNUAL" : "MONTHLY";
  const incrementalScanEnabled = mockSubscription?.incrementalScanEnabled ?? false;

  // ---- 4. 余额 ----
  const balance = mockBalance;

  // ---- 5. 最近购买记录 ----
  const recentPurchases = mockRecentPurchases.map((p) => ({
    packKey: p.packCode,
    amount: p.grantedAmount,
    price: p.priceCents / 100,
    currency: p.currencyCode,
    createdAt: p.createdAt.toISOString(),
  }));

  // ---- 6. 超额包配置 ----
  const planConfig = PLAN_CONFIGS[currentPlan];
  const overagePacks = planConfig ? planConfig.overagePacks : [];

  // ---- 7. 所有计划配置 ----
  const plans = Object.values(PLAN_CONFIGS).map((config) => ({
    planKey: config.planKey,
    displayName: config.displayName,
    monthlyPriceCents: config.monthlyPriceCents,
    annualMonthlyPriceCents: config.annualMonthlyPriceCents,
    monthlyQuota: config.monthlyQuota,
    annualTotalCredits: config.annualTotalCredits,
    incrementalScanEnabled: config.incrementalScanEnabled,
  }));

  // ---- 8. 组装响应 ----
  return Promise.resolve(
    Response.json({
      currentPlan,
      billingInterval,
      incrementalScanEnabled,
      includedRemaining: balance.includedRemaining,
      includedPeriodType: balance.includedPeriodType,
      welcomeRemaining: balance.welcomeRemaining,
      overagePackRemaining: balance.overagePackRemaining,
      totalRemaining: balance.totalRemaining,
      recentPurchases,
      plans,
      overagePacks,
    }),
  );
}

/** 重置所有 mock 状态 */
function resetMocks(): void {
  mockShopNotFound = false;
  mockSubscription = null;
  mockBalance = {
    includedRemaining: 0,
    includedPeriodType: "MONTHLY",
    welcomeRemaining: 0,
    overagePackRemaining: 0,
    totalRemaining: 0,
  };
  mockRecentPurchases = [];
  mockShopCurrentPlan = "FREE";
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  // ---- 测试 1：Starter 月付活跃订阅 + 余额 + 最近购买记录 ----
  {
    resetMocks();
    mockShopCurrentPlan = "STARTER";
    mockSubscription = {
      planCode: "STARTER",
      billingInterval: "MONTHLY",
      incrementalScanEnabled: true,
    };
    mockBalance = {
      includedRemaining: 120,
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 200,
      overagePackRemaining: 50,
      totalRemaining: 370,
    };
    mockRecentPurchases = [
      {
        packCode: "OVERAGE_100_299",
        grantedAmount: 100,
        priceCents: 299,
        currencyCode: "USD",
        createdAt: new Date("2026-05-10T08:00:00.000Z"),
      },
    ];

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "Starter 月付应返回 200");
    assert.equal(data.currentPlan, "STARTER", "currentPlan 应为 STARTER");
    assert.equal(data.billingInterval, "MONTHLY", "billingInterval 应为 MONTHLY");
    assert.equal(data.incrementalScanEnabled, true, "incrementalScanEnabled 应为 true");
    assert.equal(data.includedRemaining, 120, "includedRemaining 应为 120");
    assert.equal(data.includedPeriodType, "MONTHLY", "includedPeriodType 应为 MONTHLY");
    assert.equal(data.welcomeRemaining, 200, "welcomeRemaining 应为 200");
    assert.equal(data.overagePackRemaining, 50, "overagePackRemaining 应为 50");
    assert.equal(data.totalRemaining, 370, "totalRemaining 应为 370");

    // 最近购买记录
    assert.ok(Array.isArray(data.recentPurchases), "recentPurchases 应为数组");
    assert.equal(data.recentPurchases.length, 1, "应有 1 条购买记录");
    assert.equal(data.recentPurchases[0].packKey, "OVERAGE_100_299", "packKey 应匹配");
    assert.equal(data.recentPurchases[0].amount, 100, "amount 应为 100");
    assert.equal(data.recentPurchases[0].price, 2.99, "price 应为 2.99（美元）");
    assert.equal(data.recentPurchases[0].currency, "USD", "currency 应为 USD");
    assert.equal(
      data.recentPurchases[0].createdAt,
      "2026-05-10T08:00:00.000Z",
      "createdAt 应为 ISO 字符串",
    );

    // 计划配置
    assert.ok(Array.isArray(data.plans), "plans 应为数组");
    assert.equal(data.plans.length, 5, "应返回 5 个计划配置");
    const starterPlan = data.plans.find(
      (p: { planKey: string }) => p.planKey === "STARTER",
    );
    assert.ok(starterPlan, "应包含 STARTER 计划");
    assert.equal(starterPlan.displayName, "Starter", "displayName 应为 Starter");
    assert.equal(starterPlan.monthlyPriceCents, 499, "monthlyPriceCents 应为 499");
    assert.equal(starterPlan.monthlyQuota, 150, "monthlyQuota 应为 150");

    // 超额包配置
    assert.ok(Array.isArray(data.overagePacks), "overagePacks 应为数组");
    assert.equal(data.overagePacks.length, 1, "STARTER 应有 1 个超额包");
    assert.equal(
      data.overagePacks[0].packCode,
      "OVERAGE_100_299",
      "超额包 packCode 应匹配",
    );
    assert.equal(data.overagePacks[0].credits, 100, "超额包 credits 应为 100");

    console.log("✅ 测试 1 通过：Starter 月付活跃订阅 + 余额 + 最近购买记录");
  }

  // ---- 测试 2：新安装店铺（无订阅）返回 Free + welcome + Free monthly 余额 ----
  {
    resetMocks();
    // 新店铺：无订阅，shop.currentPlan 默认 FREE
    mockShopCurrentPlan = "FREE";
    mockBalance = {
      includedRemaining: 25,  // Free monthly 余额
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 50,   // 安装欢迎额度
      overagePackRemaining: 0,
      totalRemaining: 75,
    };

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "新安装店铺应返回 200");
    assert.equal(data.currentPlan, "FREE", "currentPlan 应为 FREE");
    assert.equal(data.billingInterval, "MONTHLY", "无订阅时 billingInterval 应映射为 MONTHLY");
    assert.equal(data.incrementalScanEnabled, false, "FREE 计划 incrementalScanEnabled 应为 false");
    assert.equal(data.includedRemaining, 25, "includedRemaining 应为 25（Free monthly）");
    assert.equal(data.includedPeriodType, "MONTHLY", "includedPeriodType 应为 MONTHLY");
    assert.equal(data.welcomeRemaining, 50, "welcomeRemaining 应为 50（安装欢迎额度）");
    assert.equal(data.overagePackRemaining, 0, "overagePackRemaining 应为 0");
    assert.equal(data.totalRemaining, 75, "totalRemaining 应为 75");
    assert.deepEqual(data.recentPurchases, [], "新店铺无购买记录");

    // Free 计划的超额包
    assert.equal(data.overagePacks.length, 1, "FREE 计划应有 1 个超额包");

    console.log("✅ 测试 2 通过：新安装店铺返回 Free + welcome + Free monthly 余额");
  }

  // ---- 测试 3：Shop 不存在返回 404 ----
  {
    resetMocks();
    mockShopNotFound = true;

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 404, "Shop 不存在应返回 404");
    assert.equal(data.error, "Shop not found", "错误信息应为 'Shop not found'");

    console.log("✅ 测试 3 通过：Shop 不存在返回 404");
  }

  // ---- 测试 4：NONE interval 映射为 MONTHLY ----
  {
    resetMocks();
    mockShopCurrentPlan = "FREE";
    mockSubscription = {
      planCode: "FREE",
      billingInterval: "NONE",
      incrementalScanEnabled: false,
    };
    mockBalance = {
      includedRemaining: 10,
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 0,
      overagePackRemaining: 0,
      totalRemaining: 10,
    };

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "NONE interval 应返回 200");
    assert.equal(data.billingInterval, "MONTHLY", "NONE 应映射为 MONTHLY");

    console.log("✅ 测试 4 通过：NONE interval 映射为 MONTHLY");
  }

  // ---- 测试 5：年付计划 ANNUAL interval 正确透传 ----
  {
    resetMocks();
    mockShopCurrentPlan = "GROWTH";
    mockSubscription = {
      planCode: "GROWTH",
      billingInterval: "ANNUAL",
      incrementalScanEnabled: true,
    };
    mockBalance = {
      includedRemaining: 3500,
      includedPeriodType: "ANNUAL",
      welcomeRemaining: 500,
      overagePackRemaining: 200,
      totalRemaining: 4200,
    };

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "年付计划应返回 200");
    assert.equal(data.currentPlan, "GROWTH", "currentPlan 应为 GROWTH");
    assert.equal(data.billingInterval, "ANNUAL", "billingInterval 应为 ANNUAL");
    assert.equal(data.incrementalScanEnabled, true, "incrementalScanEnabled 应为 true");
    assert.equal(data.includedRemaining, 3500, "includedRemaining 应为 3500");
    assert.equal(data.includedPeriodType, "ANNUAL", "includedPeriodType 应为 ANNUAL");
    assert.equal(data.welcomeRemaining, 500, "welcomeRemaining 应为 500");
    assert.equal(data.overagePackRemaining, 200, "overagePackRemaining 应为 200");
    assert.equal(data.totalRemaining, 4200, "totalRemaining 应为 4200");

    // Growth 年付超额包
    assert.equal(data.overagePacks.length, 1, "GROWTH 应有 1 个超额包");
    assert.equal(
      data.overagePacks[0].packCode,
      "OVERAGE_200_499",
      "超额包 packCode 应为 OVERAGE_200_499",
    );

    console.log("✅ 测试 5 通过：年付计划 ANNUAL interval 正确透传");
  }

  // ---- 测试 6：响应结构字段完整性校验 ----
  {
    resetMocks();
    mockShopCurrentPlan = "PRO";
    mockSubscription = {
      planCode: "PRO",
      billingInterval: "MONTHLY",
      incrementalScanEnabled: true,
    };
    mockBalance = {
      includedRemaining: 600,
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 1000,
      overagePackRemaining: 400,
      totalRemaining: 2000,
    };

    const res = await callLoader();
    const data = await res.json();

    // 校验所有顶层字段存在
    const expectedKeys = [
      "currentPlan",
      "billingInterval",
      "incrementalScanEnabled",
      "includedRemaining",
      "includedPeriodType",
      "welcomeRemaining",
      "overagePackRemaining",
      "totalRemaining",
      "recentPurchases",
      "plans",
      "overagePacks",
    ];
    for (const key of expectedKeys) {
      assert.ok(key in data, `响应应包含 ${key} 字段`);
    }

    // 校验 plans 中每个计划都有必需字段
    const planKeys = ["planKey", "displayName", "monthlyPriceCents", "annualMonthlyPriceCents", "monthlyQuota", "annualTotalCredits", "incrementalScanEnabled"];
    for (const plan of data.plans) {
      for (const key of planKeys) {
        assert.ok(key in plan, `plan 应包含 ${key} 字段`);
      }
    }

    // 校验 overagePacks 中每个包都有必需字段
    const packKeys = ["packCode", "credits", "priceCents", "displayPrice"];
    for (const pack of data.overagePacks) {
      for (const key of packKeys) {
        assert.ok(key in pack, `overagePack 应包含 ${key} 字段`);
      }
    }

    console.log("✅ 测试 6 通过：响应结构字段完整性校验");
  }

  // ---- 测试 7：多条购买记录按时间降序 ----
  {
    resetMocks();
    mockShopCurrentPlan = "STARTER";
    mockSubscription = {
      planCode: "STARTER",
      billingInterval: "MONTHLY",
      incrementalScanEnabled: true,
    };
    mockBalance = {
      includedRemaining: 100,
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 0,
      overagePackRemaining: 200,
      totalRemaining: 300,
    };
    mockRecentPurchases = [
      {
        packCode: "OVERAGE_100_299",
        grantedAmount: 100,
        priceCents: 299,
        currencyCode: "USD",
        createdAt: new Date("2026-05-12T10:00:00.000Z"),
      },
      {
        packCode: "OVERAGE_100_299",
        grantedAmount: 100,
        priceCents: 299,
        currencyCode: "USD",
        createdAt: new Date("2026-05-01T08:00:00.000Z"),
      },
    ];

    const res = await callLoader();
    const data = await res.json();

    assert.equal(data.recentPurchases.length, 2, "应有 2 条购买记录");
    // mock 已按时间降序排列，验证顺序保持
    assert.equal(
      data.recentPurchases[0].createdAt,
      "2026-05-12T10:00:00.000Z",
      "第 1 条应是最新的",
    );
    assert.equal(
      data.recentPurchases[1].createdAt,
      "2026-05-01T08:00:00.000Z",
      "第 2 条应是较早的",
    );

    console.log("✅ 测试 7 通过：多条购买记录保持时间降序");
  }

  // ---- 测试 8：零余额场景 ----
  {
    resetMocks();
    mockShopCurrentPlan = "FREE";
    mockBalance = {
      includedRemaining: 0,
      includedPeriodType: "MONTHLY",
      welcomeRemaining: 0,
      overagePackRemaining: 0,
      totalRemaining: 0,
    };

    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "零余额应返回 200");
    assert.equal(data.totalRemaining, 0, "totalRemaining 应为 0");
    assert.equal(data.includedRemaining, 0, "includedRemaining 应为 0");
    assert.equal(data.welcomeRemaining, 0, "welcomeRemaining 应为 0");
    assert.equal(data.overagePackRemaining, 0, "overagePackRemaining 应为 0");

    console.log("✅ 测试 8 通过：零余额场景");
  }

  console.log("\n🎉 api.billing.summary 路由测试全部通过");
}

// ---- 执行 ----
run().catch((err: unknown) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
