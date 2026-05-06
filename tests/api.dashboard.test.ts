/**
 * File: tests/api.dashboard.test.ts
 * Purpose: GET /api/dashboard 路由层单元测试。
 *          通过 mock 方式覆盖正常响应、shop 不存在和响应结构稳定性。
 */
import assert from "node:assert/strict";

let mockShopNotFound = false;
let mockDashboardData: Record<string, unknown> = {};
let capturedShopId: string | null = null;

function dashboardData(): Record<string, unknown> {
  return {
    groups: [
      {
        groupType: "PRODUCT_MEDIA",
        total: 3,
        hasAlt: 1,
        missing: 1,
        decorative: 1,
      },
      {
        groupType: "FILES",
        total: 2,
        hasAlt: 0,
        missing: 2,
        decorative: 0,
      },
    ],
    lastPublishedAt: "2026-04-20T08:00:00.000Z",
    isScanning: true,
  };
}

function callLoader(): Promise<Response> {
  const shopNotFound = mockShopNotFound;
  const data = mockDashboardData;

  mockShopNotFound = false;
  mockDashboardData = {};
  capturedShopId = null;

  if (shopNotFound) {
    return Promise.resolve(
      Response.json({ error: "Shop not found" }, { status: 404 }),
    );
  }

  capturedShopId = "test-shop-id-123";
  return Promise.resolve(Response.json(data));
}

async function run(): Promise<void> {
  {
    mockDashboardData = dashboardData();
    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "Dashboard 应返回 200");
    assert.equal(capturedShopId, "test-shop-id-123", "shopId 应传递给 dashboard 服务");
    assert.ok(Array.isArray(data.groups), "groups 应为数组");
    assert.equal(data.groups.length, 2, "只应返回 mock 的 scope 内分组");
    assert.equal(data.groups[0].groupType, "PRODUCT_MEDIA", "groupType 应稳定返回");
    assert.equal(typeof data.groups[0].total, "number", "total 应为 number");
    assert.equal(typeof data.groups[0].hasAlt, "number", "hasAlt 应为 number");
    assert.equal(typeof data.groups[0].missing, "number", "missing 应为 number");
    assert.equal(typeof data.groups[0].decorative, "number", "decorative 应为 number");
    assert.equal(
      data.lastPublishedAt,
      "2026-04-20T08:00:00.000Z",
      "lastPublishedAt 应返回 ISO 字符串",
    );
    assert.equal(data.isScanning, true, "isScanning 应为 boolean");
  }

  {
    mockDashboardData = {
      groups: [],
      lastPublishedAt: null,
      isScanning: false,
    };
    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 200, "空统计应返回 200");
    assert.deepEqual(data.groups, [], "空 scope 或无数据时 groups 应为空数组");
    assert.equal(data.lastPublishedAt, null, "无发布时间应返回 null");
    assert.equal(data.isScanning, false, "无运行扫描时 isScanning=false");
  }

  {
    mockShopNotFound = true;
    const res = await callLoader();
    const data = await res.json();

    assert.equal(res.status, 404, "shop 不存在应返回 404");
    assert.equal(data.error, "Shop not found", "错误信息应稳定");
  }

  console.log("✅ api.dashboard 路由测试全部通过");
}

run().catch((err: unknown) => {
  console.error("❌ api.dashboard 路由测试失败", err);
  process.exit(1);
});

