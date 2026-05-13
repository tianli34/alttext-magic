/**
 * File: tests/credit-balance.server.test.ts
 * Purpose: credit-balance.server.ts + consumption-order.ts 单元测试
 *
 * 测试覆盖：
 *   A. consumption-order 排序逻辑
 *      1. included family 优先于 welcome
 *      2. welcome 优先于 overage pack
 *      3. 多个 included bucket 按 expiresAt ASC 排序
 *      4. expiresAt 为 null 的 included 排到最后
 *   B. getCreditBalance 分组余额
 *      5. 各分组余额正确汇总
 *      6. includedPeriodType 推断（MONTHLY / ANNUAL）
 *      7. 无桶时返回全零
 *   C. planCreditAllocation 额度分配
 *      8. 单桶足额分配
 *      9. 跨桶分配（included → welcome）
 *     10. 跨桶分配（included → welcome → overage）
 *     11. 额度不足时 enough = false
 *     12. amount <= 0 抛错
 *     13. shopId 为空抛错
 *
 * Usage: npx tsx tests/credit-balance.server.test.ts
 */

import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 劫持模块
void Prisma;

// ============================================================================
// 测试框架
// ============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    failed++;
    const msg = `${label}: expected to throw but did not`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  } catch {
    passed++;
  }
}

// ============================================================================
// Mock 工厂
// ============================================================================

/** 创建 mock CreditBucket 记录 */
function makeBucket(overrides: Partial<{
  id: string;
  bucketType: string;
  remainingAmount: number;
  status: string;
  expiresAt: Date | null;
  effectiveAt: Date;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'bucket-001',
    shopId: 'shop-001',
    billingSubscriptionId: null,
    overagePackPurchaseId: null,
    bucketType: overrides.bucketType ?? 'FREE_MONTHLY_INCLUDED',
    status: overrides.status ?? 'ACTIVE',
    cycleKey: 'FREE:2026-05',
    grantedAmount: overrides.remainingAmount ?? 25,
    reservedAmount: 0,
    consumedAmount: 0,
    remainingAmount: overrides.remainingAmount ?? 25,
    effectiveAt: overrides.effectiveAt ?? new Date('2026-05-01T00:00:00Z'),
    expiresAt: overrides.expiresAt ?? null,
    activatedAt: new Date('2026-05-12T00:00:00Z'),
    exhaustedAt: null,
    createdAt: overrides.createdAt ?? new Date('2026-05-12T00:00:00Z'),
    updatedAt: new Date('2026-05-12T00:00:00Z'),
  };
}

/** 创建 mock PrismaClient */
function createMockPrisma(buckets: ReturnType<typeof makeBucket>[]) {
  return {
    creditBucket: {
      findMany: async () => buckets,
    },
  };
}

// ============================================================================
// 导入被测模块
// ============================================================================

const {
  sortBucketsByConsumptionOrder,
  isIncludedFamily,
  getConsumptionPriority,
} = await import('../server/modules/billing/credit/consumption-order.js');

const {
  getSpendableBuckets,
  getCreditBalance,
  planCreditAllocation,
} = await import('../server/modules/billing/credit/credit-balance.server.js');

// ============================================================================
// 测试用例
// ============================================================================

async function run(): Promise<void> {
  console.log('\n=== credit-balance.server.test.ts ===\n');

  // ========================================================================
  // A. consumption-order 排序逻辑
  // ========================================================================
  console.log('--- A. consumption-order 排序逻辑 ---\n');

  // ------------------------------------------------------------------
  // A1. included family 优先于 welcome
  // ------------------------------------------------------------------
  {
    const buckets = [
      { bucketType: 'WELCOME' as const, remainingAmount: 100, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'MONTHLY_INCLUDED' as const, remainingAmount: 50, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
    ];
    const sorted = sortBucketsByConsumptionOrder(buckets);
    assertEqual(sorted[0].bucketType, 'MONTHLY_INCLUDED', 'A1: included 优先于 welcome (position 0)');
    assertEqual(sorted[1].bucketType, 'WELCOME', 'A1: welcome 排在第二位');
    console.log('  ✓ 验收：included family 优先于 welcome');
  }

  // ------------------------------------------------------------------
  // A2. welcome 优先于 overage pack
  // ------------------------------------------------------------------
  {
    const buckets = [
      { bucketType: 'OVERAGE_PACK' as const, remainingAmount: 200, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'WELCOME' as const, remainingAmount: 100, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
    ];
    const sorted = sortBucketsByConsumptionOrder(buckets);
    assertEqual(sorted[0].bucketType, 'WELCOME', 'A2: welcome 优先于 overage (position 0)');
    assertEqual(sorted[1].bucketType, 'OVERAGE_PACK', 'A2: overage 排在第二位');
    console.log('  ✓ 验收：welcome 优先于 overage pack');
  }

  // ------------------------------------------------------------------
  // A3. 多个 included bucket 按 expiresAt ASC 排序
  // ------------------------------------------------------------------
  {
    const early = new Date('2026-06-01T00:00:00Z');
    const late = new Date('2026-12-01T00:00:00Z');

    const buckets = [
      { bucketType: 'ANNUAL_INCLUDED' as const, remainingAmount: 100, expiresAt: late, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'FREE_MONTHLY_INCLUDED' as const, remainingAmount: 25, expiresAt: early, effectiveAt: new Date(), createdAt: new Date() },
    ];
    const sorted = sortBucketsByConsumptionOrder(buckets);
    assertEqual(sorted[0].bucketType, 'FREE_MONTHLY_INCLUDED', 'A3: 早期到期的 included 排第一');
    assertEqual(sorted[1].bucketType, 'ANNUAL_INCLUDED', 'A3: 晚期到期的 included 排第二');
    console.log('  ✓ 验收：多个 included bucket 按 expiresAt ASC 排序');
  }

  // ------------------------------------------------------------------
  // A4. expiresAt 为 null 的 included 排到最后
  // ------------------------------------------------------------------
  {
    const expires = new Date('2026-06-01T00:00:00Z');

    const buckets = [
      { bucketType: 'MONTHLY_INCLUDED' as const, remainingAmount: 100, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'FREE_MONTHLY_INCLUDED' as const, remainingAmount: 25, expiresAt: expires, effectiveAt: new Date(), createdAt: new Date() },
    ];
    const sorted = sortBucketsByConsumptionOrder(buckets);
    assertEqual(sorted[0].bucketType, 'FREE_MONTHLY_INCLUDED', 'A4: 有过期时间的 included 排第一');
    assertEqual(sorted[1].bucketType, 'MONTHLY_INCLUDED', 'A4: 无过期时间的 included 排第二');
    console.log('  ✓ 验收：expiresAt 为 null 的 included 排到最后');
  }

  // ------------------------------------------------------------------
  // A5. 完整消费顺序：included → welcome → overage
  // ------------------------------------------------------------------
  {
    const buckets = [
      { bucketType: 'OVERAGE_PACK' as const, remainingAmount: 100, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'WELCOME' as const, remainingAmount: 50, expiresAt: null, effectiveAt: new Date(), createdAt: new Date() },
      { bucketType: 'MONTHLY_INCLUDED' as const, remainingAmount: 150, expiresAt: new Date('2026-06-01'), effectiveAt: new Date(), createdAt: new Date() },
    ];
    const sorted = sortBucketsByConsumptionOrder(buckets);
    assertEqual(sorted[0].bucketType, 'MONTHLY_INCLUDED', 'A5: included 排第一');
    assertEqual(sorted[1].bucketType, 'WELCOME', 'A5: welcome 排第二');
    assertEqual(sorted[2].bucketType, 'OVERAGE_PACK', 'A5: overage 排第三');
    console.log('  ✓ 验收：完整消费顺序 included → welcome → overage');
  }

  // ------------------------------------------------------------------
  // A6. isIncludedFamily 和 getConsumptionPriority
  // ------------------------------------------------------------------
  {
    assertTrue(isIncludedFamily('FREE_MONTHLY_INCLUDED'), 'A6: FREE_MONTHLY_INCLUDED 是 included');
    assertTrue(isIncludedFamily('MONTHLY_INCLUDED'), 'A6: MONTHLY_INCLUDED 是 included');
    assertTrue(isIncludedFamily('ANNUAL_INCLUDED'), 'A6: ANNUAL_INCLUDED 是 included');

    const welcomeNotIncluded = !isIncludedFamily('WELCOME');
    assertTrue(welcomeNotIncluded, 'A6: WELCOME 不是 included');
    const overageNotIncluded = !isIncludedFamily('OVERAGE_PACK');
    assertTrue(overageNotIncluded, 'A6: OVERAGE_PACK 不是 included');

    // included 优先级 < welcome 优先级 < overage 优先级
    const incPriority = getConsumptionPriority('MONTHLY_INCLUDED');
    const welPriority = getConsumptionPriority('WELCOME');
    const ovgPriority = getConsumptionPriority('OVERAGE_PACK');
    assertTrue(incPriority < welPriority, 'A6: included 优先级 < welcome');
    assertTrue(welPriority < ovgPriority, 'A6: welcome 优先级 < overage');
    console.log('  ✓ 验收：isIncludedFamily 和 getConsumptionPriority 正确');
  }

  // ========================================================================
  // B. getCreditBalance 分组余额
  // ========================================================================
  console.log('\n--- B. getCreditBalance 分组余额 ---\n');

  // ------------------------------------------------------------------
  // B1. 各分组余额正确汇总
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-inc1', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 100, expiresAt: new Date('2026-06-01') }),
      makeBucket({ id: 'b-inc2', bucketType: 'FREE_MONTHLY_INCLUDED', remainingAmount: 25, expiresAt: new Date('2026-06-01') }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 200 }),
      makeBucket({ id: 'b-ovg', bucketType: 'OVERAGE_PACK', remainingAmount: 100 }),
    ];

    const mockPrisma = createMockPrisma(mockBuckets);
    const balance = await getCreditBalance('shop-001', mockPrisma as never);

    assertEqual(balance.includedRemaining, 125, 'B1: includedRemaining = 100 + 25');
    assertEqual(balance.welcomeRemaining, 200, 'B1: welcomeRemaining = 200');
    assertEqual(balance.overagePackRemaining, 100, 'B1: overagePackRemaining = 100');
    assertEqual(balance.totalRemaining, 425, 'B1: totalRemaining = 425');
    assertEqual(balance.includedPeriodType, 'MONTHLY', 'B1: includedPeriodType = MONTHLY');
    assertEqual(balance.buckets.length, 4, 'B1: 4 个桶');
    console.log('  ✓ 验收：各分组余额正确汇总');
  }

  // ------------------------------------------------------------------
  // B2. includedPeriodType 推断为 ANNUAL
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-ann', bucketType: 'ANNUAL_INCLUDED', remainingAmount: 1800 }),
    ];

    const mockPrisma = createMockPrisma(mockBuckets);
    const balance = await getCreditBalance('shop-001', mockPrisma as never);

    assertEqual(balance.includedPeriodType, 'ANNUAL', 'B2: includedPeriodType = ANNUAL');
    assertEqual(balance.includedRemaining, 1800, 'B2: includedRemaining = 1800');
    console.log('  ✓ 验收：includedPeriodType 正确推断为 ANNUAL');
  }

  // ------------------------------------------------------------------
  // B3. 无桶时返回全零
  // ------------------------------------------------------------------
  {
    const mockPrisma = createMockPrisma([]);
    const balance = await getCreditBalance('shop-001', mockPrisma as never);

    assertEqual(balance.includedRemaining, 0, 'B3: 无桶 includedRemaining = 0');
    assertEqual(balance.welcomeRemaining, 0, 'B3: 无桶 welcomeRemaining = 0');
    assertEqual(balance.overagePackRemaining, 0, 'B3: 无桶 overagePackRemaining = 0');
    assertEqual(balance.totalRemaining, 0, 'B3: 无桶 totalRemaining = 0');
    assertEqual(balance.includedPeriodType, 'MONTHLY', 'B3: 无桶 includedPeriodType 默认 MONTHLY');
    assertEqual(balance.buckets.length, 0, 'B3: 无桶 buckets 为空');
    console.log('  ✓ 验收：无桶时返回全零');
  }

  // ------------------------------------------------------------------
  // B4. 桶按消费顺序排列
  // ------------------------------------------------------------------
  {
    // Prisma 返回乱序
    const mockBuckets = [
      makeBucket({ id: 'b-ovg', bucketType: 'OVERAGE_PACK', remainingAmount: 100 }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 50 }),
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 150, expiresAt: new Date('2026-06-01') }),
    ];

    const mockPrisma = createMockPrisma(mockBuckets);
    const balance = await getCreditBalance('shop-001', mockPrisma as never);

    assertEqual(balance.buckets[0].bucketId, 'b-inc', 'B4: included 排第一');
    assertEqual(balance.buckets[1].bucketId, 'b-wel', 'B4: welcome 排第二');
    assertEqual(balance.buckets[2].bucketId, 'b-ovg', 'B4: overage 排第三');
    console.log('  ✓ 验收：桶按消费顺序排列');
  }

  // ========================================================================
  // C. planCreditAllocation 额度分配
  // ========================================================================
  console.log('\n--- C. planCreditAllocation 额度分配 ---\n');

  // ------------------------------------------------------------------
  // C1. 单桶足额分配
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 200, expiresAt: new Date('2026-06-01') }),
    ];
    const mockPrisma = createMockPrisma(mockBuckets);

    const plan = await planCreditAllocation('shop-001', 150, mockPrisma as never);

    assertTrue(plan.enough, 'C1: enough = true');
    assertEqual(plan.requested, 150, 'C1: requested = 150');
    assertEqual(plan.allocatable, 150, 'C1: allocatable = 150');
    assertEqual(plan.allocation.length, 1, 'C1: 1 个分配条目');
    assertEqual(plan.allocation[0].bucketId, 'b-inc', 'C1: 分配到 included 桶');
    assertEqual(plan.allocation[0].amount, 150, 'C1: 分配量 = 150');
    console.log('  ✓ 验收：单桶足额分配');
  }

  // ------------------------------------------------------------------
  // C2. 跨桶分配（included → welcome）
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 150, expiresAt: new Date('2026-06-01') }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 200 }),
    ];
    const mockPrisma = createMockPrisma(mockBuckets);

    const plan = await planCreditAllocation('shop-001', 180, mockPrisma as never);

    assertTrue(plan.enough, 'C2: enough = true');
    assertEqual(plan.allocatable, 180, 'C2: allocatable = 180');
    assertEqual(plan.allocation.length, 2, 'C2: 2 个分配条目');
    assertEqual(plan.allocation[0].bucketId, 'b-inc', 'C2: 第一个分配到 included');
    assertEqual(plan.allocation[0].amount, 150, 'C2: included 分配 150');
    assertEqual(plan.allocation[1].bucketId, 'b-wel', 'C2: 第二个分配到 welcome');
    assertEqual(plan.allocation[1].amount, 30, 'C2: welcome 分配 30');
    console.log('  ✓ 验收：跨桶分配 included → welcome');
  }

  // ------------------------------------------------------------------
  // C3. 跨桶分配（included → welcome → overage）
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 100, expiresAt: new Date('2026-06-01') }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 50 }),
      makeBucket({ id: 'b-ovg', bucketType: 'OVERAGE_PACK', remainingAmount: 200 }),
    ];
    const mockPrisma = createMockPrisma(mockBuckets);

    const plan = await planCreditAllocation('shop-001', 250, mockPrisma as never);

    assertTrue(plan.enough, 'C3: enough = true');
    assertEqual(plan.allocatable, 250, 'C3: allocatable = 250');
    assertEqual(plan.allocation.length, 3, 'C3: 3 个分配条目');
    assertEqual(plan.allocation[0].amount, 100, 'C3: included 分配 100');
    assertEqual(plan.allocation[1].amount, 50, 'C3: welcome 分配 50');
    assertEqual(plan.allocation[2].amount, 100, 'C3: overage 分配 100');
    console.log('  ✓ 验收：跨桶分配 included → welcome → overage');
  }

  // ------------------------------------------------------------------
  // C4. 额度不足时 enough = false
  // ------------------------------------------------------------------
  {
    const mockBuckets = [
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 50, expiresAt: new Date('2026-06-01') }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 30 }),
    ];
    const mockPrisma = createMockPrisma(mockBuckets);

    const plan = await planCreditAllocation('shop-001', 100, mockPrisma as never);

    assertFalse(plan.enough, 'C4: enough = false');
    assertEqual(plan.requested, 100, 'C4: requested = 100');
    assertEqual(plan.allocatable, 80, 'C4: allocatable = 80 (50 + 30)');
    assertEqual(plan.allocation.length, 2, 'C4: 2 个分配条目');
    assertEqual(plan.allocation[0].amount, 50, 'C4: included 分配 50');
    assertEqual(plan.allocation[1].amount, 30, 'C4: welcome 分配 30');
    console.log('  ✓ 验收：额度不足时 enough = false');
  }

  // ------------------------------------------------------------------
  // C5. 无桶时额度不足
  // ------------------------------------------------------------------
  {
    const mockPrisma = createMockPrisma([]);
    const plan = await planCreditAllocation('shop-001', 10, mockPrisma as never);

    assertFalse(plan.enough, 'C5: 无桶 enough = false');
    assertEqual(plan.allocatable, 0, 'C5: 无桶 allocatable = 0');
    assertEqual(plan.allocation.length, 0, 'C5: 无桶 allocation 为空');
    console.log('  ✓ 验收：无桶时额度不足');
  }

  // ------------------------------------------------------------------
  // C6. amount <= 0 抛错
  // ------------------------------------------------------------------
  {
    await assertThrowsAsync(
      () => planCreditAllocation('shop-001', 0, createMockPrisma([]) as never),
      'C6: amount = 0 抛错',
    );
    await assertThrowsAsync(
      () => planCreditAllocation('shop-001', -5, createMockPrisma([]) as never),
      'C6: amount = -5 抛错',
    );
    console.log('  ✓ 验收：amount <= 0 抛错');
  }

  // ------------------------------------------------------------------
  // C7. shopId 为空抛错
  // ------------------------------------------------------------------
  {
    await assertThrowsAsync(
      () => getSpendableBuckets('', createMockPrisma([]) as never),
      'C7: getSpendableBuckets shopId 为空抛错',
    );
    await assertThrowsAsync(
      () => getCreditBalance('', createMockPrisma([]) as never),
      'C7: getCreditBalance shopId 为空抛错',
    );
    console.log('  ✓ 验收：shopId 为空抛错');
  }

  // ------------------------------------------------------------------
  // C8. 多个 included bucket 按消费顺序分配
  // ------------------------------------------------------------------
  {
    const early = new Date('2026-06-01T00:00:00Z');
    const late = new Date('2026-12-31T23:59:59Z');

    const mockBuckets = [
      // Prisma 返回顺序可能是乱的
      makeBucket({ id: 'b-inc-late', bucketType: 'ANNUAL_INCLUDED', remainingAmount: 500, expiresAt: late }),
      makeBucket({ id: 'b-inc-early', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 100, expiresAt: early }),
    ];
    const mockPrisma = createMockPrisma(mockBuckets);

    const plan = await planCreditAllocation('shop-001', 150, mockPrisma as never);

    assertTrue(plan.enough, 'C8: enough = true');
    assertEqual(plan.allocation.length, 2, 'C8: 2 个分配条目');
    // 早期到期的应该先被分配
    assertEqual(plan.allocation[0].bucketId, 'b-inc-early', 'C8: 早期 included 先分配');
    assertEqual(plan.allocation[0].amount, 100, 'C8: 早期 included 分配 100');
    assertEqual(plan.allocation[1].bucketId, 'b-inc-late', 'C8: 晚期 included 后分配');
    assertEqual(plan.allocation[1].amount, 50, 'C8: 晚期 included 分配 50');
    console.log('  ✓ 验收：多个 included bucket 按 expiresAt ASC 顺序分配');
  }

  // ------------------------------------------------------------------
  // 汇总
  // ------------------------------------------------------------------
  console.log('\n' + '─'.repeat(60));
  console.log(`  总计: ${passed + failed}  通过: ${passed}  失败: ${failed}`);

  if (failures.length > 0) {
    console.log('\n  失败详情:');
    for (const f of failures) {
      console.log(`    • ${f}`);
    }
    process.exit(1);
  }

  console.log('\n  🎉 全部测试通过!\n');
}

function assertFalse(value: boolean, label: string): void {
  assertEqual(value, false, label);
}

run().catch((err: unknown) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
