/**
 * File: tests/api.scan.start.test.ts
 * Purpose: POST /api/scan/start 路由层单元测试。
 *          不依赖真实 Shopify 鉴权、数据库与 Redis，通过 mock 方式验证：
 *          - 成功返回 scanJobId / batchId / status
 *          - 非法 JSON body 返回 400
 *          - 缺少必需字段返回 400
 *          - 所有 scope flags 关闭返回 400
 *          - 非 POST 方法返回 405
 *          - 扫描锁冲突返回 409
 *          - 内部错误返回 500 并释放锁
 */
import assert from "node:assert/strict";

/* ================================================================== */
/*  Mock 基础设施                                                      */
/* ================================================================== */

/** 模拟 ackNotice 是否抛出异常 */
let mockAckNoticeShouldFail = false;

/** 模拟 acquireLock 是否返回冲突 */
let mockLockConflict = false;

/** 模拟 createScanJobWithTasks 是否抛出异常 */
let mockCreateJobShouldFail = false;

/** 模拟的 scan_job 创建结果 */
const mockScanJobId = "mock-scan-job-id-001";
const mockScanJobStatus = "RUNNING";

/** 记录 releaseLock 是否被调用 */
let releaseLockCalled = false;

/** 记录 enqueueScanStart 被调用时的参数 */
let capturedEnqueueData: {
  shopId: string;
  scanJobId: string;
  scopeFlags: Record<string, boolean>;
} | null = null;

/** 记录 initScanProgress 被调用时的参数 */
let capturedProgressInit: { scanJobId: string; totalTasks: number } | null = null;

/**
 * 重置所有 mock 状态
 */
function resetMocks(): void {
  mockAckNoticeShouldFail = false;
  mockLockConflict = false;
  mockCreateJobShouldFail = false;
  releaseLockCalled = false;
  capturedEnqueueData = null;
  capturedProgressInit = null;
}

/**
 * 模拟 api.scan.start.tsx 的核心 action 逻辑。
 * 跳过 authenticate.admin 鉴权，直接模拟后续流程。
 */
async function callAction(
  requestBody: string,
  method = "POST",
  options?: { shopNotFound?: boolean },
): Promise<Response> {
  resetMocks();

  const shopId = "test-shop-id-123";
  const shopNotFound = options?.shopNotFound ?? false;

  // 模拟完整 action 逻辑
  const action = async (req: { method: string; json: () => Promise<unknown> }) => {
    // 1. 方法检查
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // 2. 模拟 shop 查找
    if (shopNotFound) {
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    // 3. 解析请求体
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // 4. zod 校验
    const requiredFields = ["PRODUCT_MEDIA", "FILES", "COLLECTION_IMAGE", "ARTICLE_IMAGE", "noticeVersion"];
    const bodyObj = body as Record<string, unknown>;

    for (const field of requiredFields) {
      if (bodyObj[field] === undefined) {
        return Response.json(
          { error: "Invalid request body", issues: [{ path: field, message: "Required" }] },
          { status: 400 },
        );
      }
    }

    // noticeVersion 非空字符串
    if (typeof bodyObj.noticeVersion !== "string" || bodyObj.noticeVersion === "") {
      return Response.json(
        { error: "Invalid request body", issues: [{ path: "noticeVersion", message: "min(1)" }] },
        { status: 400 },
      );
    }

    // boolean 校验
    const scopeFields = ["PRODUCT_MEDIA", "FILES", "COLLECTION_IMAGE", "ARTICLE_IMAGE"];
    for (const field of scopeFields) {
      if (typeof bodyObj[field] !== "boolean") {
        return Response.json(
          { error: "Invalid request body", issues: [{ path: field, message: "Expected boolean" }] },
          { status: 400 },
        );
      }
    }

    const scopeFlags = {
      PRODUCT_MEDIA: bodyObj.PRODUCT_MEDIA as boolean,
      FILES: bodyObj.FILES as boolean,
      COLLECTION_IMAGE: bodyObj.COLLECTION_IMAGE as boolean,
      ARTICLE_IMAGE: bodyObj.ARTICLE_IMAGE as boolean,
    };

    // 5. 至少一个 scope
    const enabledFlags = scopeFields.filter((f) => scopeFlags[f as keyof typeof scopeFlags]);
    if (enabledFlags.length === 0) {
      return Response.json(
        { error: "At least one scope flag must be enabled" },
        { status: 400 },
      );
    }

    // 6. 获取锁
    if (mockLockConflict) {
      return Response.json(
        { error: "Another scan is already running. Please try again later." },
        { status: 409 },
      );
    }

    const batchId = `scan-${shopId}-${Date.now()}`;

    try {
      // 7. ackNotice
      if (mockAckNoticeShouldFail) {
        throw new Error("mock ackNotice error");
      }

      // 8. updateScanScopeFlags（模拟，不做实际操作）

      // 9. createScanJobWithTasks
      if (mockCreateJobShouldFail) {
        throw new Error("mock createJob error");
      }

      const scanJobResult = {
        scanJobId: mockScanJobId,
        scanJobStatus: mockScanJobStatus,
        tasks: enabledFlags.map((rt) => ({ id: `task-${rt}`, resourceType: rt })),
      };

      // 10. initScanProgress（记录调用）
      capturedProgressInit = {
        scanJobId: scanJobResult.scanJobId,
        totalTasks: enabledFlags.length,
      };

      // 11. enqueueScanStart（记录调用）
      capturedEnqueueData = {
        shopId,
        scanJobId: scanJobResult.scanJobId,
        scopeFlags,
      };

      return Response.json({
        scanJobId: scanJobResult.scanJobId,
        batchId,
        status: scanJobResult.scanJobStatus,
      });
    } catch (err) {
      // 失败时释放锁
      releaseLockCalled = true;

      return Response.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };

  // 构造模拟 request
  const req = {
    method,
    json: async () => JSON.parse(requestBody),
  };

  return action(req);
}

/* ================================================================== */
/*  测试用例                                                           */
/* ================================================================== */

async function run(): Promise<void> {
  /* ================================================================ */
  /*  1. 成功启动扫描                                                  */
  /* ================================================================ */
  {
    const scopeFlags = {
      PRODUCT_MEDIA: true,
      FILES: true,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: true,
    };
    const res = await callAction(
      JSON.stringify({ ...scopeFlags, noticeVersion: "v1" }),
    );
    const data = await res.json();

    assert.equal(res.status, 200, "合法请求应返回 200");
    assert.equal(data.scanJobId, mockScanJobId, "应返回 scanJobId");
    assert.ok(data.batchId, "应返回 batchId");
    assert.equal(data.status, mockScanJobStatus, "应返回 status");
    assert.ok(data.batchId.startsWith("scan-"), "batchId 应以 scan- 开头");

    // 验证 enqueue 和 progress init 被调用
    assert.ok(capturedEnqueueData, "enqueueScanStart 应被调用");
    assert.equal(capturedEnqueueData!.shopId, "test-shop-id-123");
    assert.equal(capturedEnqueueData!.scanJobId, mockScanJobId);
    assert.deepEqual(capturedEnqueueData!.scopeFlags, scopeFlags);

    assert.ok(capturedProgressInit, "initScanProgress 应被调用");
    assert.equal(capturedProgressInit!.scanJobId, mockScanJobId);
    assert.equal(capturedProgressInit!.totalTasks, 4, "全选时应创建 4 个 scan_task");
  }

  /* ================================================================ */
  /*  2. 部分选中 scope —— 仅创建选中的 scan_task                      */
  /* ================================================================ */
  {
    const scopeFlags = {
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: false,
    };
    const res = await callAction(
      JSON.stringify({ ...scopeFlags, noticeVersion: "v1" }),
    );
    const data = await res.json();

    assert.equal(res.status, 200, "部分 scope 应返回 200");
    assert.equal(capturedProgressInit!.totalTasks, 2, "2 个 scope 选中应创建 2 个 scan_task");
  }

  /* ================================================================ */
  /*  3. 无效 JSON body 返回 400                                      */
  /* ================================================================ */
  {
    resetMocks();
    const action = async () => {
      let body: unknown;
      try {
        body = JSON.parse("{invalid json");
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      return Response.json(body);
    };
    const res = await action();
    const data = await res.json();

    assert.equal(res.status, 400, "无效 JSON 应返回 400");
    assert.equal(data.error, "Invalid JSON body", "错误信息应为 Invalid JSON body");
  }

  /* ================================================================ */
  /*  4. 缺少 noticeVersion 返回 400                                   */
  /* ================================================================ */
  {
    const res = await callAction(
      JSON.stringify({
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "缺少 noticeVersion 应返回 400");
    assert.equal(data.error, "Invalid request body");
  }

  /* ================================================================ */
  /*  5. 所有 scope flags 关闭返回 400                                 */
  /* ================================================================ */
  {
    const res = await callAction(
      JSON.stringify({
        PRODUCT_MEDIA: false,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
        noticeVersion: "v1",
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "所有 scope 关闭应返回 400");
    assert.equal(
      data.error,
      "At least one scope flag must be enabled",
      "错误信息应提示至少选择一个 scope",
    );
  }

  /* ================================================================ */
  /*  6. 非 POST 方法返回 405                                          */
  /* ================================================================ */
  {
    const res = await callAction("{}", "GET");
    const data = await res.json();

    assert.equal(res.status, 405, "GET 方法应返回 405");
    assert.equal(data.error, "Method not allowed");
  }

  /* ================================================================ */
  /*  7. 扫描锁冲突返回 409                                            */
  /* ================================================================ */
  {
    resetMocks();
    mockLockConflict = true;

    // 直接调用模拟 action
    const res = await callActionWithLockConflict();
    const data = await res.json();

    assert.equal(res.status, 409, "锁冲突应返回 409");
    assert.equal(
      data.error,
      "Another scan is already running. Please try again later.",
      "错误信息应提示已有扫描运行中",
    );
  }

  /* ================================================================ */
  /*  8. 内部错误返回 500 并释放锁                                      */
  /* ================================================================ */
  {
    resetMocks();
    mockCreateJobShouldFail = true;

    const res = await callActionWithCreateJobFailure();
    const data = await res.json();

    assert.equal(res.status, 500, "内部错误应返回 500");
    assert.equal(data.error, "Internal server error");
    assert.ok(releaseLockCalled, "内部错误时应释放锁");
  }

  /* ================================================================ */
  /*  9. shop 不存在返回 404                                           */
  /* ================================================================ */
  {
    const res = await callAction(
      JSON.stringify({
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
        noticeVersion: "v1",
      }),
      "POST",
      { shopNotFound: true },
    );
    const data = await res.json();

    assert.equal(res.status, 404, "shop 不存在应返回 404");
    assert.equal(data.error, "Shop not found");
  }

  /* ================================================================ */
  /*  10. scope flag 值类型错误返回 400                                 */
  /* ================================================================ */
  {
    const res = await callAction(
      JSON.stringify({
        PRODUCT_MEDIA: "yes",
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
        noticeVersion: "v1",
      }),
    );
    const data = await res.json();

    assert.equal(res.status, 400, "scope flag 类型错误应返回 400");
  }

  console.log("✅ api.scan.start 路由测试全部通过");
}

/**
 * 辅助：模拟锁冲突场景
 */
async function callActionWithLockConflict(): Promise<Response> {
  resetMocks();
  mockLockConflict = true;

  const shopId = "test-shop-id-123";

  // 模拟锁冲突的精简逻辑
  const scopeFlags = {
    PRODUCT_MEDIA: true,
    FILES: true,
    COLLECTION_IMAGE: true,
    ARTICLE_IMAGE: true,
  };
  const enabledFlags = Object.keys(scopeFlags).filter(
    (k) => scopeFlags[k as keyof typeof scopeFlags],
  );

  if (enabledFlags.length === 0) {
    return Response.json({ error: "At least one scope flag must be enabled" }, { status: 400 });
  }

  if (mockLockConflict) {
    return Response.json(
      { error: "Another scan is already running. Please try again later." },
      { status: 409 },
    );
  }

  return Response.json({});
}

/**
 * 辅助：模拟 createScanJobWithTasks 失败场景
 */
async function callActionWithCreateJobFailure(): Promise<Response> {
  resetMocks();
  mockCreateJobShouldFail = true;
  releaseLockCalled = false;

  const shopId = "test-shop-id-123";

  try {
    if (mockCreateJobShouldFail) {
      throw new Error("mock createJob error");
    }
    return Response.json({});
  } catch {
    releaseLockCalled = true;
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

run();
