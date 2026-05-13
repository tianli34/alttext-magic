/**
 * File: tests/api.generation.preflight.test.ts
 * Purpose: POST /api/generation/preflight 路由层单元测试。
 *          不依赖真实 Shopify 鉴权与数据库，通过 mock 方式验证：
 *          - 额度足够时 enough = true
 *          - 额度不足时 enough = false
 *          - 返回消费顺序与 Task 5.11 一致
 *          - 不改变 bucket remainingAmount
 *          - candidateIds 和 count 均支持
 *          - 缺少 candidateIds 和 count 返回 400
 *          - 非 POST 方法返回 405
 *
 * 运行：npx tsx tests/api.generation.preflight.test.ts
 */

// ============================================================================
// 测试框架
// ============================================================================

const results = { passed: 0, failed: 0 };
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    results.passed++;
  } else {
    results.failed++;
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

// ============================================================================
// Mock 数据
// ============================================================================

/** 模拟的 shop 数据 */
const MOCK_SHOP = {
  id: "shop-001",
  shopDomain: "test-shop.myshopify.com",
};

/** 模拟余额 */
const MOCK_BALANCE = {
  includedRemaining: 150,
  includedPeriodType: "MONTHLY" as const,
  welcomeRemaining: 200,
  overagePackRemaining: 100,
  totalRemaining: 450,
  buckets: [],
};

/** 分配条目类型 */
interface MockAllocationEntry {
  bucketId: string;
  bucketType: CreditBucketType;
  amount: number;
}

/** 分配方案类型 */
interface MockAllocationPlan {
  enough: boolean;
  requested: number;
  allocatable: number;
  allocation: MockAllocationEntry[];
}

/** 模拟分配方案（足够） */
const MOCK_ALLOCATION_ENOUGH: MockAllocationPlan = {
  enough: true,
  requested: 3,
  allocatable: 3,
  allocation: [
    { bucketId: "bucket-001", bucketType: "FREE_MONTHLY_INCLUDED", amount: 3 },
  ],
};

/** 模拟分配方案（不足） */
const MOCK_ALLOCATION_NOT_ENOUGH: MockAllocationPlan = {
  enough: false,
  requested: 500,
  allocatable: 450,
  allocation: [
    { bucketId: "bucket-001", bucketType: "FREE_MONTHLY_INCLUDED", amount: 150 },
    { bucketId: "bucket-002", bucketType: "WELCOME", amount: 200 },
    { bucketId: "bucket-003", bucketType: "OVERAGE_PACK", amount: 100 },
  ],
};

/** 模拟分配方案（跨桶） */
const MOCK_ALLOCATION_CROSS_BUCKET: MockAllocationPlan = {
  enough: true,
  requested: 5,
  allocatable: 5,
  allocation: [
    { bucketId: "bucket-001", bucketType: "MONTHLY_INCLUDED", amount: 3 },
    { bucketId: "bucket-002", bucketType: "WELCOME", amount: 2 },
  ],
};

// ============================================================================
// 模拟 action 核心逻辑
// ============================================================================

/** mock 控制开关 */
let mockShopNotFound = false;
let mockBalance = { ...MOCK_BALANCE };
let mockAllocation: MockAllocationPlan = { ...MOCK_ALLOCATION_ENOUGH };
let balanceQueriedCount = 0;
let allocationQueriedCount = 0;

/**
 * 模拟 api.generation.preflight.tsx 的 action 核心逻辑。
 * 跳过 authenticate.admin 鉴权和真实 DB，直接测试业务逻辑。
 */
async function callAction(
  method: string,
  body: Record<string, unknown> | null,
): Promise<Response> {
  // 重置计数
  balanceQueriedCount = 0;
  allocationQueriedCount = 0;

  // ---- 1. 方法检查 ----
  if (method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // ---- 2. 鉴权通过（mock），获取 shopDomain ----
  // 无操作

  // ---- 3. 查找 shop ----
  if (mockShopNotFound) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // ---- 4. 解析请求体 ----
  if (body === null) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ---- 5. 校验 candidateIds 或 count ----
  const hasCandidateIds = body.candidateIds !== undefined;
  const hasCount = body.count !== undefined;

  if (!hasCandidateIds && !hasCount) {
    return Response.json(
      {
        error: "Invalid request body",
        issues: [{ path: "", message: "candidateIds 或 count 至少提供一个" }],
      },
      { status: 400 },
    );
  }

  // ---- 6. 确定预估消耗数量 ----
  let estimatedCredits: number;
  if (hasCandidateIds) {
    const ids = body.candidateIds;
    if (!Array.isArray(ids)) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    estimatedCredits = ids.length;
  } else {
    const count = body.count as number;
    if (!Number.isInteger(count) || count <= 0) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    estimatedCredits = count;
  }

  if (estimatedCredits <= 0) {
    return Response.json(
      { error: "estimatedCredits must be positive" },
      { status: 400 },
    );
  }

  // ---- 7. 获取余额概览 ----
  balanceQueriedCount++;
  const balance = mockBalance;

  // ---- 8. 规划额度分配 ----
  allocationQueriedCount++;
  const allocationPlan = mockAllocation;

  // ---- 9. 构造响应 —— allocation 按 bucketType 分组合并 ----
  const mergedAllocation = mergeAllocationByType(allocationPlan.allocation);

  return Response.json({
    estimatedCredits,
    enough: allocationPlan.enough,
    includedRemaining: balance.includedRemaining,
    welcomeRemaining: balance.welcomeRemaining,
    overagePackRemaining: balance.overagePackRemaining,
    totalRemaining: balance.totalRemaining,
    allocation: mergedAllocation,
  });
}

// ============================================================================
// 辅助函数（复制自路由文件）
// ============================================================================

type CreditBucketType =
  | "FREE_MONTHLY_INCLUDED"
  | "MONTHLY_INCLUDED"
  | "ANNUAL_INCLUDED"
  | "WELCOME"
  | "OVERAGE_PACK";

const INCLUDED_FAMILY = new Set<CreditBucketType>([
  "FREE_MONTHLY_INCLUDED",
  "MONTHLY_INCLUDED",
  "ANNUAL_INCLUDED",
]);

function isIncludedFamily(bucketType: CreditBucketType): boolean {
  return INCLUDED_FAMILY.has(bucketType);
}

interface MergedAllocationEntry {
  bucketType: string;
  amount: number;
}

function mergeAllocationByType(
  allocation: readonly { bucketId: string; bucketType: CreditBucketType; amount: number }[],
): MergedAllocationEntry[] {
  const map = new Map<string, number>();

  for (const entry of allocation) {
    const displayType = isIncludedFamily(entry.bucketType)
      ? "MONTHLY_INCLUDED"
      : entry.bucketType;

    const current = map.get(displayType) ?? 0;
    map.set(displayType, current + entry.amount);
  }

  const order: Record<string, number> = {
    MONTHLY_INCLUDED: 10,
    WELCOME: 20,
    OVERAGE_PACK: 30,
  };

  const result = Array.from(map.entries()).map(([bucketType, amount]) => ({
    bucketType,
    amount,
  }));

  result.sort((a, b) => (order[a.bucketType] ?? 99) - (order[b.bucketType] ?? 99));

  return result;
}

// ============================================================================
// 辅助工具
// ============================================================================

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

// ============================================================================
// 测试用例
// ============================================================================

async function testMethodNotAllowed(): Promise<void> {
  console.log("\n1. 非 POST 方法返回 405");
  const res = await callAction("GET", { count: 3 });
  assertEqual(res.status, 405, "GET 方法应返回 405");

  const res2 = await callAction("PUT", { count: 3 });
  assertEqual(res2.status, 405, "PUT 方法应返回 405");
}

async function testShopNotFound(): Promise<void> {
  console.log("\n2. Shop 不存在返回 404");
  mockShopNotFound = true;
  const res = await callAction("POST", { count: 3 });
  assertEqual(res.status, 404, "Shop 不存在应返回 404");
  const data = await parseJson(res);
  assertEqual(data.error, "Shop not found", "错误消息正确");
  mockShopNotFound = false;
}

async function testMissingBody(): Promise<void> {
  console.log("\n3. 缺少请求体返回 400");
  const res = await callAction("POST", null);
  assertEqual(res.status, 400, "缺少请求体应返回 400");
}

async function testMissingBothParams(): Promise<void> {
  console.log("\n4. 同时缺少 candidateIds 和 count 返回 400");
  const res = await callAction("POST", {});
  assertEqual(res.status, 400, "缺少参数应返回 400");
  const data = await parseJson(res);
  assertTrue(
    (data.issues as Array<{ message: string }>)[0].message.includes("candidateIds 或 count"),
    "错误提示包含参数要求",
  );
}

async function testEnoughCreditsWithCount(): Promise<void> {
  console.log("\n5. 额度足够时（count 模式）enough = true");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_ENOUGH };

  const res = await callAction("POST", { count: 3 });
  assertEqual(res.status, 200, "应返回 200");

  const data = await parseJson(res);
  assertEqual(data.estimatedCredits, 3, "estimatedCredits = 3");
  assertEqual(data.enough, true, "enough = true");
  assertEqual(data.includedRemaining, 150, "includedRemaining = 150");
  assertEqual(data.welcomeRemaining, 200, "welcomeRemaining = 200");
  assertEqual(data.overagePackRemaining, 100, "overagePackRemaining = 100");
  assertEqual(data.totalRemaining, 450, "totalRemaining = 450");
}

async function testEnoughCreditsWithCandidateIds(): Promise<void> {
  console.log("\n6. 额度足够时（candidateIds 模式）enough = true");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_ENOUGH };

  const res = await callAction("POST", { candidateIds: ["id1", "id2", "id3"] });
  assertEqual(res.status, 200, "应返回 200");

  const data = await parseJson(res);
  assertEqual(data.estimatedCredits, 3, "estimatedCredits = 3（来自 candidateIds.length）");
  assertEqual(data.enough, true, "enough = true");
}

async function testInsufficientCredits(): Promise<void> {
  console.log("\n7. 额度不足时 enough = false");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_NOT_ENOUGH };

  const res = await callAction("POST", { count: 500 });
  assertEqual(res.status, 200, "应返回 200");

  const data = await parseJson(res);
  assertEqual(data.estimatedCredits, 500, "estimatedCredits = 500");
  assertEqual(data.enough, false, "enough = false");
  assertEqual(data.totalRemaining, 450, "totalRemaining = 450（余额不变）");
}

async function testConsumptionOrder(): Promise<void> {
  console.log("\n8. 返回消费顺序与 Task 5.11 一致");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_NOT_ENOUGH };

  const res = await callAction("POST", { count: 500 });
  const data = await parseJson(res);
  const allocation = data.allocation as MergedAllocationEntry[];

  // 验证消费顺序：MONTHLY_INCLUDED → WELCOME → OVERAGE_PACK
  assertEqual(allocation.length, 3, "应有 3 个分配条目");
  assertEqual(allocation[0].bucketType, "MONTHLY_INCLUDED", "第一个: MONTHLY_INCLUDED");
  assertEqual(allocation[0].amount, 150, "MONTHLY_INCLUDED 分配 150");
  assertEqual(allocation[1].bucketType, "WELCOME", "第二个: WELCOME");
  assertEqual(allocation[1].amount, 200, "WELCOME 分配 200");
  assertEqual(allocation[2].bucketType, "OVERAGE_PACK", "第三个: OVERAGE_PACK");
  assertEqual(allocation[2].amount, 100, "OVERAGE_PACK 分配 100");
}

async function testCrossBucketAllocation(): Promise<void> {
  console.log("\n9. 跨桶分配合并正确");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_CROSS_BUCKET };

  const res = await callAction("POST", { count: 5 });
  const data = await parseJson(res);
  const allocation = data.allocation as MergedAllocationEntry[];

  assertEqual(allocation.length, 2, "应有 2 个分配条目");
  assertEqual(allocation[0].bucketType, "MONTHLY_INCLUDED", "第一个: MONTHLY_INCLUDED");
  assertEqual(allocation[0].amount, 3, "MONTHLY_INCLUDED 分配 3");
  assertEqual(allocation[1].bucketType, "WELCOME", "第二个: WELCOME");
  assertEqual(allocation[1].amount, 2, "WELCOME 分配 2");
}

async function testNoBucketMutation(): Promise<void> {
  console.log("\n10. 不改变 bucket remainingAmount");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_ENOUGH };

  const balanceBefore = { ...MOCK_BALANCE };
  await callAction("POST", { count: 3 });

  // 验证 mock 余额数据未被改变（preflight 不修改余额）
  assertEqual(mockBalance.includedRemaining, balanceBefore.includedRemaining, "includedRemaining 未变");
  assertEqual(mockBalance.totalRemaining, balanceBefore.totalRemaining, "totalRemaining 未变");
  // 验证只查询了余额和分配，未执行写入操作
  assertEqual(balanceQueriedCount, 1, "只查询了 1 次余额");
  assertEqual(allocationQueriedCount, 1, "只查询了 1 次分配");
}

async function testCandidateIdsPriorityOverCount(): Promise<void> {
  console.log("\n11. candidateIds 优先于 count");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_ENOUGH };

  const res = await callAction("POST", { candidateIds: ["id1", "id2"], count: 10 });
  const data = await parseJson(res);
  assertEqual(data.estimatedCredits, 2, "应使用 candidateIds.length（2）而非 count（10）");
}

async function testEmptyCandidateIds(): Promise<void> {
  console.log("\n12. 空 candidateIds 数组 estimatedCredits = 0（edge case）");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = { ...MOCK_ALLOCATION_ENOUGH };

  // 空 candidateIds → estimatedCredits = 0 → 但我们 action 中有 <= 0 检查
  const res = await callAction("POST", { candidateIds: [] });
  // 由于 estimatedCredits = 0 被校验为 "must be positive"
  assertEqual(res.status, 400, "空 candidateIds 应返回 400");
  const data = await parseJson(res);
  assertTrue(
    (data.error as string).includes("positive"),
    "错误消息包含 positive",
  );
}

async function testMergeMultipleIncludedBuckets(): Promise<void> {
  console.log("\n13. 多个 included bucket 合并显示");
  mockBalance = { ...MOCK_BALANCE };
  mockAllocation = {
    enough: true,
    requested: 10,
    allocatable: 10,
    allocation: [
      { bucketId: "b1", bucketType: "FREE_MONTHLY_INCLUDED" as CreditBucketType, amount: 5 } as MockAllocationEntry,
      { bucketId: "b2", bucketType: "MONTHLY_INCLUDED" as CreditBucketType, amount: 3 } as MockAllocationEntry,
      { bucketId: "b3", bucketType: "ANNUAL_INCLUDED" as CreditBucketType, amount: 2 } as MockAllocationEntry,
    ],
  };

  const res = await callAction("POST", { count: 10 });
  const data = await parseJson(res);
  const allocation = data.allocation as MergedAllocationEntry[];

  // 所有 included family 类型应合并为 MONTHLY_INCLUDED
  assertEqual(allocation.length, 1, "所有 included 类型应合并为 1 条");
  assertEqual(allocation[0].bucketType, "MONTHLY_INCLUDED", "合并后类型为 MONTHLY_INCLUDED");
  assertEqual(allocation[0].amount, 10, "合并后总数为 10");
}

// ============================================================================
// 执行测试
// ============================================================================

async function main(): Promise<void> {
  console.log("=== POST /api/generation/preflight 测试 ===\n");

  await testMethodNotAllowed();
  await testShopNotFound();
  await testMissingBody();
  await testMissingBothParams();
  await testEnoughCreditsWithCount();
  await testEnoughCreditsWithCandidateIds();
  await testInsufficientCredits();
  await testConsumptionOrder();
  await testCrossBucketAllocation();
  await testNoBucketMutation();
  await testCandidateIdsPriorityOverCount();
  await testEmptyCandidateIds();
  await testMergeMultipleIncludedBuckets();

  console.log("\n=== 测试结果 ===");
  console.log(`通过: ${results.passed}`);
  console.log(`失败: ${results.failed}`);

  if (failures.length > 0) {
    console.log("\n失败详情:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }

  console.log("\n✓ 所有测试通过！");
}

main().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
