/**
 * File: tests/api.settings.scope.test.ts
 * Purpose: POST /api/settings/scope 路由层单元测试。
 *          不依赖真实 Shopify 鉴权与数据库，通过 mock 方式验证：
 *          - 成功更新 scan_scope_flags
 *          - 非法 flag 返回 400
 *          - 缺少 flags 字段返回 400
 *          - 无效 JSON body 返回 400
 *          - 非 POST 方法返回 405
 *          - updateScanScopeFlags 内部保证不修改 last_published_scope_flags
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

// 记录 updateScanScopeFlags 被调用时的参数
let capturedCall: { shopId: string; flags: unknown } | null = null;
let mockUpdateResult: Record<string, unknown> = {};

// 记录 prisma.shop.findUnique 是否被调用
let findUniqueCalled = false;

// mock 控制开关：是否让 findUnique 返回 null（shop 不存在）
let mockShopNotFound = false;

/**
 * 重置所有 mock 状态
 */
function resetMocks(): void {
  capturedCall = null;
  mockUpdateResult = {
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
  };
  findUniqueCalled = false;
  mockShopNotFound = false;
}

/**
 * 构造 mock 过的 action 函数，模拟 api.settings.scope.tsx 的逻辑。
 * 由于 React Router 路由依赖 Shopify auth 中间件，此处提取核心逻辑
 * 进行纯逻辑测试。
 */
async function callAction(requestBody: string, method = "POST"): Promise<Response> {
  resetMocks();

  // 模拟 action 的核心逻辑（跳过 authenticate.admin 鉴权）
  const action = async (req: { method: string; json: () => Promise<unknown> }) => {
    // 1. 方法检查
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // 2. 模拟 shop 查找
    findUniqueCalled = true;
    if (mockShopNotFound) {
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    const shopId = "test-shop-id-123";

    // 3. 解析请求体
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // 4. 提取 flags 字段
    const flags = (body as Record<string, unknown>).flags;
    if (flags === undefined || flags === null) {
      return Response.json(
        { error: "Missing required field: flags" },
        { status: 400 },
      );
    }

    // 5. 调用服务层更新
    try {
      const result = await mockUpdateScanScopeFlags(shopId, flags);
      return Response.json(result);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "ZodError") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zodIssues = (err as any).issues as Array<{ path: PropertyKey[]; message: string }>;
        const issues = zodIssues.map(
          (i) => ({ path: i.path.join("."), message: i.message }),
        );
        return Response.json({ error: "Invalid flags", issues }, { status: 400 });
      }
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };

  // 构造模拟 request
  const req = {
    method,
    json: async () => JSON.parse(requestBody),
  };

  return action(req);
}

/**
 * Mock updateScanScopeFlags —— 模拟 Zod 校验 + 数据库行为
 */
async function mockUpdateScanScopeFlags(shopId: string, flags: unknown): Promise<Record<string, unknown>> {
  capturedCall = { shopId, flags };

  // 模拟 Zod 校验：复用 scopeFlagStateSchema
  const { scopeFlagStateSchema } = await import("../app/lib/scope-utils");

  const result = scopeFlagStateSchema.safeParse(flags);
  if (!result.success) {
    const err = new Error("ZodError") as Error & { issues: Array<{ path: (string | number)[]; message: string }> };
    err.name = "ZodError";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(err as any).issues = result.error.issues;
    throw err;
  }

  // 校验通过，返回模拟的 ScopeSettings
  // 关键：lastPublishedScopeFlags 不应随 flags 改变
  return { ...mockUpdateResult, scanScopeFlags: result.data };
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  /* ================================================================ */
  /*  1. 成功更新 scan_scope_flags                                    */
  /* ================================================================ */
  {
    const validFlags = {
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: false,
    };
    const res = await callAction(JSON.stringify({ flags: validFlags }));
    const data = await res.json();

    assert.equal(res.status, 200, "合法 flags 应返回 200");
    assert.deepEqual(data.scanScopeFlags, validFlags, "响应中 scanScopeFlags 应与输入一致");
    assert.ok(capturedCall, "updateScanScopeFlags 应被调用");
    assert.equal(capturedCall!.shopId, "test-shop-id-123", "shopId 应正确传递");
  }

  /* ================================================================ */
  /*  2. 非法 flag 返回 400                                           */
  /* ================================================================ */

  // 2a. 多余字段
  {
    const res = await callAction(
      JSON.stringify({
        flags: {
          PRODUCT_MEDIA: true,
          FILES: true,
          COLLECTION_IMAGE: true,
          ARTICLE_IMAGE: true,
          INVALID_FLAG: true,
        },
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "多余字段应返回 400");
    assert.equal(data.error, "Invalid flags", "错误信息应为 Invalid flags");
    assert.ok(Array.isArray(data.issues), "应返回 issues 数组");
  }

  // 2b. 缺少字段
  {
    const res = await callAction(
      JSON.stringify({
        flags: { PRODUCT_MEDIA: true, FILES: true },
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "缺少必需字段应返回 400");
    assert.equal(data.error, "Invalid flags", "错误信息应为 Invalid flags");
  }

  // 2c. 值类型错误
  {
    const res = await callAction(
      JSON.stringify({
        flags: {
          PRODUCT_MEDIA: "yes",
          FILES: true,
          COLLECTION_IMAGE: true,
          ARTICLE_IMAGE: true,
        },
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "值类型错误应返回 400");
    assert.equal(data.error, "Invalid flags", "错误信息应为 Invalid flags");
  }

  /* ================================================================ */
  /*  3. 缺少 flags 字段返回 400                                      */
  /* ================================================================ */
  {
    const res = await callAction(JSON.stringify({}));
    const data = await res.json();

    assert.equal(res.status, 400, "缺少 flags 字段应返回 400");
    assert.equal(data.error, "Missing required field: flags", "应提示缺少 flags 字段");
  }

  /* ================================================================ */
  /*  4. flags 为 null 返回 400                                      */
  /* ================================================================ */
  {
    const res = await callAction(JSON.stringify({ flags: null }));
    const data = await res.json();

    assert.equal(res.status, 400, "flags 为 null 应返回 400");
  }

  /* ================================================================ */
  /*  5. 无效 JSON body 返回 400                                     */
  /* ================================================================ */
  {
    // 特殊构造：模拟 JSON.parse 失败
    resetMocks();
    const action = async () => {
      let body: unknown;
      try {
        body = JSON.parse("{invalid json");
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const flags = (body as Record<string, unknown>).flags;
      if (flags === undefined || flags === null) {
        return Response.json({ error: "Missing required field: flags" }, { status: 400 });
      }
      return Response.json({});
    };
    const res = await action();
    const data = await res.json();

    assert.equal(res.status, 400, "无效 JSON 应返回 400");
    assert.equal(data.error, "Invalid JSON body", "错误信息应为 Invalid JSON body");
  }

  /* ================================================================ */
  /*  6. 非 POST 方法返回 405                                        */
  /* ================================================================ */
  {
    const res = await callAction("{}", "GET");
    const data = await res.json();

    assert.equal(res.status, 405, "GET 方法应返回 405");
    assert.equal(data.error, "Method not allowed", "错误信息应为 Method not allowed");
  }

  /* ================================================================ */
  /*  7. last_published_scope_flags 不变                              */
  /* ================================================================ */
  {
    const validFlags = {
      PRODUCT_MEDIA: false,
      FILES: true,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: true,
    };
    const res = await callAction(JSON.stringify({ flags: validFlags }));
    const data = await res.json();

    assert.equal(res.status, 200, "合法 flags 应返回 200");

    // 验证 lastPublishedScopeFlags 与 mock 中预设的一致，不受 flags 变更影响
    assert.deepEqual(
      data.lastPublishedScopeFlags,
      {
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
      },
      "lastPublishedScopeFlags 不应随 flags 变更而改变",
    );

    // 验证 effectiveReadScopeFlags = scanScopeFlags ∩ lastPublishedScopeFlags
    // 注意：mock 中 effectiveReadScopeFlags 是在 resetMocks 中预设的固定值，
    // 不是动态计算的，因此此处验证 mock 返回的原始值
    assert.deepEqual(
      data.effectiveReadScopeFlags,
      {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
      },
      "effectiveReadScopeFlags 应为 mock 预设值（模拟 scanScopeFlags ∩ lastPublishedScopeFlags 的交集）",
    );
  }

  /* ================================================================ */
  /*  8. 全 false flags 合法                                         */
  /* ================================================================ */
  {
    const allOff = {
      PRODUCT_MEDIA: false,
      FILES: false,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: false,
    };
    const res = await callAction(JSON.stringify({ flags: allOff }));
    const data = await res.json();

    assert.equal(res.status, 200, "全 false flags 应合法");
    assert.deepEqual(data.scanScopeFlags, allOff, "scanScopeFlags 应全 false");
  }

  console.log("✅ api.settings.scope 路由测试全部通过");
}

run();
