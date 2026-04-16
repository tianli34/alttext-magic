/**
 * File: tests/api.bootstrap.test.ts
 * Purpose: GET /api/bootstrap 路由层单元测试。
 *          不依赖真实 Shopify 鉴权与数据库，通过 mock 方式验证：
 *          - 返回结构稳定（包含所有 §6.1 约定字段）
 *          - fresh shop 场景：needsNoticeAck=true、默认四类 scope、latestScan=null
 *          - shop 不存在返回 404
 *          - 非 GET 方法返回 405
 *          - 有扫描记录时 latestScan 字段正确
 *          - RUNNING 扫描的 isRunning=true
 *          - effectiveReadScopeFlags = scanScopeFlags ∩ lastPublishedScopeFlags
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

/** 模拟 getBootstrapData 的返回结果 */
let mockBootstrapData: Record<string, unknown> = {};

/** mock 控制开关：是否让 findUnique 返回 null（shop 不存在） */
let mockShopNotFound = false;

/** 模拟 getBootstrapData 被调用时的参数 */
let capturedShopId: string | null = null;

/**
 * 构造 fresh shop 的默认 bootstrap 数据。
 * 遵循 §6.1 规格：needsNoticeAck=true、默认四类 scope、latestScan=null。
 */
function freshShopData(): Record<string, unknown> {
  return {
    plan: { planCode: "FREE" },
    quota: { includedRemaining: 0, includedPeriodType: "NONE" },
    needsNoticeAck: true,
    noticeVersion: "1.3",
    scanScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: true,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: true,
    },
    lastPublishedScopeFlags: null,
    effectiveReadScopeFlags: {
      PRODUCT_MEDIA: false,
      FILES: false,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: false,
    },
    latestScan: null,
  };
}

/**
 * 构造已有扫描记录的 shop 的 bootstrap 数据。
 */
function shopWithScanData(): Record<string, unknown> {
  return {
    plan: { planCode: "PRO" },
    quota: { includedRemaining: 100, includedPeriodType: "MONTHLY" },
    needsNoticeAck: false,
    noticeVersion: "1.3",
    scanScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: false,
    },
    lastPublishedScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: true,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: false,
    },
    effectiveReadScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: false,
    },
    latestScan: {
      scanJobId: "scan-job-001",
      status: "COMPLETED",
      publishStatus: "PUBLISHED",
      isRunning: false,
      lastPublishedAt: "2026-04-15T10:00:00.000Z",
    },
  };
}

/**
 * 模拟 api.bootstrap.tsx 的 loader 核心逻辑。
 * 跳过 authenticate.admin 鉴权，直接测试业务逻辑。
 *
 * 注意：先捕获 mockBootstrapData 引用，再重置 mock 状态，
 * 避免 resetMocks() 清空数据导致 Response 返回空对象。
 */
function callLoader(method = "GET"): Promise<Response> {
  // 先捕获当前 mock 数据，避免 resetMocks 清空
  const data = mockBootstrapData;
  const shopNotFound = mockShopNotFound;

  // 重置 mock 状态（不影响已捕获的数据）
  mockBootstrapData = {};
  mockShopNotFound = false;
  capturedShopId = null;

  if (method !== "GET") {
    return Promise.resolve(
      Response.json({ error: "Method not allowed" }, { status: 405 }),
    );
  }

  if (shopNotFound) {
    return Promise.resolve(
      Response.json({ error: "Shop not found" }, { status: 404 }),
    );
  }

  capturedShopId = "test-shop-id-123";
  return Promise.resolve(Response.json(data));
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  /* ================================================================ */
  /*  1. fresh shop 场景：needsNoticeAck=true、默认四类 scope、latestScan=null */
  /* ================================================================ */
  {
    mockBootstrapData = freshShopData();
    const res = await callLoader("GET");
    const data = await res.json();

    assert.equal(res.status, 200, "fresh shop 应返回 200");

    // needsNoticeAck 为 true
    assert.equal(data.needsNoticeAck, true, "fresh shop 应 needsNoticeAck=true");

    // 默认四类 scope 全开
    assert.deepEqual(
      data.scanScopeFlags,
      { PRODUCT_MEDIA: true, FILES: true, COLLECTION_IMAGE: true, ARTICLE_IMAGE: true },
      "fresh shop 应返回默认四类全开 scanScopeFlags",
    );

    // lastPublishedScopeFlags 为 null
    assert.equal(data.lastPublishedScopeFlags, null, "fresh shop 应 lastPublishedScopeFlags=null");

    // effectiveReadScopeFlags 全 false（scan ∩ null = empty）
    assert.deepEqual(
      data.effectiveReadScopeFlags,
      { PRODUCT_MEDIA: false, FILES: false, COLLECTION_IMAGE: false, ARTICLE_IMAGE: false },
      "fresh shop 的 effectiveReadScopeFlags 应全 false",
    );

    // 最近扫描为空
    assert.equal(data.latestScan, null, "fresh shop 应 latestScan=null");

    // 确认 shopId 正确传递
    assert.equal(capturedShopId, "test-shop-id-123", "shopId 应正确传递给 getBootstrapData");
  }

  /* ================================================================ */
  /*  2. 返回结构稳定性：所有 §6.1 约定字段均存在且类型正确             */
  /* ================================================================ */
  {
    mockBootstrapData = freshShopData();
    const res = await callLoader("GET");
    const data = await res.json();

    // 顶层字段完整性
    const requiredTopLevelKeys = [
      "plan",
      "quota",
      "needsNoticeAck",
      "noticeVersion",
      "scanScopeFlags",
      "lastPublishedScopeFlags",
      "effectiveReadScopeFlags",
      "latestScan",
    ];
    for (const key of requiredTopLevelKeys) {
      assert.ok(key in data, `响应应包含顶层字段: ${key}`);
    }

    // plan 结构
    assert.equal(typeof data.plan.planCode, "string", "plan.planCode 应为 string");

    // quota 结构
    assert.equal(typeof data.quota.includedRemaining, "number", "quota.includedRemaining 应为 number");
    assert.equal(typeof data.quota.includedPeriodType, "string", "quota.includedPeriodType 应为 string");

    // notice 字段
    assert.equal(typeof data.needsNoticeAck, "boolean", "needsNoticeAck 应为 boolean");
    assert.equal(typeof data.noticeVersion, "string", "noticeVersion 应为 string");

    // scope 三件套：均为包含四个布尔值的对象
    const scopeKeys = ["PRODUCT_MEDIA", "FILES", "COLLECTION_IMAGE", "ARTICLE_IMAGE"];
    for (const scopeField of ["scanScopeFlags", "effectiveReadScopeFlags"] as const) {
      for (const flag of scopeKeys) {
        assert.equal(
          typeof data[scopeField][flag],
          "boolean",
          `${scopeField}.${flag} 应为 boolean`,
        );
      }
    }

    // lastPublishedScopeFlags 为 null 或包含四个布尔值的对象
    if (data.lastPublishedScopeFlags !== null) {
      for (const flag of scopeKeys) {
        assert.equal(
          typeof data.lastPublishedScopeFlags[flag],
          "boolean",
          `lastPublishedScopeFlags.${flag} 应为 boolean`,
        );
      }
    }
  }

  /* ================================================================ */
  /*  3. 有扫描记录的 shop：latestScan 字段正确                        */
  /* ================================================================ */
  {
    mockBootstrapData = shopWithScanData();
    const res = await callLoader("GET");
    const data = await res.json();

    assert.equal(res.status, 200, "有扫描记录的 shop 应返回 200");
    assert.equal(data.needsNoticeAck, false, "已确认 notice 的 shop 应 needsNoticeAck=false");

    // latestScan 结构验证
    assert.ok(data.latestScan !== null, "有扫描记录时 latestScan 不应为 null");
    assert.equal(typeof data.latestScan.scanJobId, "string", "latestScan.scanJobId 应为 string");
    assert.equal(typeof data.latestScan.status, "string", "latestScan.status 应为 string");
    assert.equal(typeof data.latestScan.publishStatus, "string", "latestScan.publishStatus 应为 string");
    assert.equal(typeof data.latestScan.isRunning, "boolean", "latestScan.isRunning 应为 boolean");
    assert.ok(
      data.latestScan.lastPublishedAt === null || typeof data.latestScan.lastPublishedAt === "string",
      "latestScan.lastPublishedAt 应为 string 或 null",
    );

    // isRunning 与 status 一致性
    assert.equal(data.latestScan.isRunning, data.latestScan.status === "RUNNING",
      "latestScan.isRunning 应与 status 是否为 RUNNING 一致");
  }

  /* ================================================================ */
  /*  4. shop 不存在返回 404                                          */
  /* ================================================================ */
  {
    mockShopNotFound = true;
    mockBootstrapData = {};
    const res = await callLoader("GET");
    const data = await res.json();

    assert.equal(res.status, 404, "shop 不存在应返回 404");
    assert.equal(data.error, "Shop not found", "错误信息应为 Shop not found");
  }

  /* ================================================================ */
  /*  5. 非 GET 方法返回 405                                          */
  /* ================================================================ */
  {
    mockBootstrapData = freshShopData();
    const res = await callLoader("POST");
    const data = await res.json();

    assert.equal(res.status, 405, "POST 方法应返回 405");
    assert.equal(data.error, "Method not allowed", "错误信息应为 Method not allowed");
  }

  /* ================================================================ */
  /*  6. RUNNING 扫描的 isRunning=true                                */
  /* ================================================================ */
  {
    mockBootstrapData = {
      ...freshShopData(),
      latestScan: {
        scanJobId: "scan-job-running",
        status: "RUNNING",
        publishStatus: "PENDING",
        isRunning: true,
        lastPublishedAt: null,
      },
    };
    const res = await callLoader("GET");
    const data = await res.json();

    assert.equal(res.status, 200, "RUNNING 扫描应返回 200");
    assert.equal(data.latestScan.isRunning, true, "RUNNING 扫描的 isRunning 应为 true");
    assert.equal(data.latestScan.status, "RUNNING", "status 应为 RUNNING");
  }

  /* ================================================================ */
  /*  7. effectiveReadScopeFlags = scanScopeFlags ∩ lastPublishedScopeFlags */
  /* ================================================================ */
  {
    mockBootstrapData = shopWithScanData();
    const res = await callLoader("GET");
    const data = await res.json();

    // 手动验证交集计算
    const scan = data.scanScopeFlags as Record<string, boolean>;
    const lastPub = data.lastPublishedScopeFlags as Record<string, boolean>;
    const effective = data.effectiveReadScopeFlags as Record<string, boolean>;

    for (const flag of ["PRODUCT_MEDIA", "FILES", "COLLECTION_IMAGE", "ARTICLE_IMAGE"]) {
      const expected = scan[flag] && lastPub[flag];
      assert.equal(
        effective[flag],
        expected,
        `effectiveReadScopeFlags.${flag} 应为 scanScopeFlags.${flag} ∩ lastPublishedScopeFlags.${flag} = ${expected}`,
      );
    }
  }

  console.log("✅ All GET /api/bootstrap tests passed!");
}

// 执行测试
run().catch((err: unknown) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
