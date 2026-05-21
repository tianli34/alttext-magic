/**
 * File: tests/apply-subscription-change.server.test.ts
 * Purpose: applySubscriptionChange 单元测试 —— 通过 mock PrismaClient 验证核心逻辑。
 *
 * 测试覆盖：
 *   1. 升级 Starter 月付（首次付费）→ MONTHLY_INCLUDED(150) + WELCOME(200)
 *   2. 升级 Growth 年付（首次付费）→ ANNUAL_INCLUDED(4200) + WELCOME(500)
 *   3. 再次升级不重复发放首次付费欢迎额度
 *   4. 年付计划缺少 externalSubscriptionId 抛错
 *   5. 降级 Free → 关闭增量扫描 + 补发 FREE_MONTHLY_INCLUDED(25)
 *   6. 降级 Free 当月已有 Free bucket（幂等，不重复发放）
 *   7. 参数校验：shopId 为空抛错
 *   8. 参数校验：subscriptionId 为空抛错
 *
 * Usage: npx tsx tests/apply-subscription-change.server.test.ts
 */

// ---- 劫持 pino —— 避免 logger 依赖 env 配置 ----
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 劫持模块
void Prisma;

// ============================================================================
// Mock 基础设施
// ============================================================================

/** 创建一条 mock CreditBucket 记录 */
function makeBucket(
  id: string,
  bucketType: string,
  amount: number,
  cycleKey: string,
) {
  return {
    id,
    shopId: 'shop-001',
    billingSubscriptionId: 'sub-001',
    overagePackPurchaseId: null,
    bucketType,
    status: 'ACTIVE',
    cycleKey,
    grantedAmount: amount,
    reservedAmount: 0,
    consumedAmount: 0,
    remainingAmount: amount,
    effectiveAt: new Date(),
    expiresAt: null,
    activatedAt: new Date(),
    exhaustedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** 创建一条 mock CreditLedger 记录 */
function makeLedger(id: string, bucketId: string, amount: number) {
  return {
    id,
    shopId: 'shop-001',
    bucketId,
    reservationId: null,
    reservationLineId: null,
    jobBatchId: null,
    type: 'GRANT',
    deltaAmount: amount,
    balanceAfter: amount,
    reason: '额度发放',
    metadata: {},
    idempotencyKey: `key-${id}`,
    externalBillingReference: null,
    eventAt: new Date(),
    createdAt: new Date(),
  };
}

/** Mock 调用记录 */
interface MockCall {
  method: string;
  data: Record<string, unknown>;
}

/** Mock Prisma 配置 */
interface MockConfig {
  /** shop.firstPaidBonusGrantedAt 返回值 */
  firstPaidBonusGrantedAt: Date | null;
  /**
   * 每个 grantCreditBucket 调用中 creditBucket.findUnique 是否返回已存在的 bucket。
   * false = 不存在（新建），true = 已存在（幂等跳过）。
   * 按调用顺序排列：[included?, welcome?, freeMonthly?]
   */
  existingBuckets: boolean[];
  /** 每个 grantCreditBucket 调用中 create 返回的 bucket 信息 */
  createdBuckets: Array<{
    id: string;
    bucketType: string;
    amount: number;
    cycleKey: string;
  }>;
}

/**
 * 创建 Mock PrismaClient。
 * 模拟 shop / billingSubscription / $transaction（grantCreditBucket 内部使用）的行为，
 * 并记录所有调用供断言验证。
 */
function createMockPrisma(config: MockConfig) {
  const calls: MockCall[] = [];
  let grantCallIndex = 0;

  // 模拟事务内的操作对象（grantCreditBucket 内部使用）
  const mockTx = {
    creditBucket: {
      findUnique: async () => {
        const idx = grantCallIndex;
        const existing = config.existingBuckets[idx] ?? false;
        if (existing) {
          const b = config.createdBuckets[idx];
          return makeBucket(b.id, b.bucketType, b.amount, b.cycleKey);
        }
        return null;
      },
      create: async (arg: { data: Record<string, unknown> }) => {
        const idx = grantCallIndex;
        calls.push({ method: `creditBucket.create[${idx}]`, data: arg.data });
        const b = config.createdBuckets[idx];
        return makeBucket(b.id, b.bucketType, b.amount, b.cycleKey);
      },
    },
    creditLedger: {
      create: async (arg: { data: Record<string, unknown> }) => {
        const idx = grantCallIndex;
        calls.push({ method: `creditLedger.create[${idx}]`, data: arg.data });
        const b = config.createdBuckets[idx];
        return makeLedger(`ledger-${idx}`, b.id, b.amount);
      },
      findUnique: async () => null,
    },
  };

  // 完整 mock PrismaClient
  const mock = {
    shop: {
      findUnique: async () => ({
        firstPaidBonusGrantedAt: config.firstPaidBonusGrantedAt,
      }),
      update: async (arg: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        calls.push({
          method: 'shop.update',
          data: { where: arg.where, ...arg.data },
        });
      },
    },
    billingSubscription: {
      update: async (arg: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        calls.push({
          method: 'billingSubscription.update',
          data: { where: arg.where, ...arg.data },
        });
      },
    },
    creditBucket: {
      findUnique: async () => null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(mockTx);
      grantCallIndex++;
      return result;
    },
    /** 暴露调用记录供断言 */
    _calls: calls,
  };

  return mock;
}

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

function assertFalse(value: boolean, label: string): void {
  assertEqual(value, false, label);
}

function assertNull(value: unknown, label: string): void {
  assertEqual(value, null, label);
}

async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
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
// 导入被测模块（在 pino mock 之后）
// ============================================================================

const { applySubscriptionChange } = await import(
  '../server/modules/billing/apply-subscription-change.server.js'
);

// ============================================================================
// 辅助：类型安全的 mock 传递
// ============================================================================

/** 将 mock PrismaClient 转换为服务接受的 PrismaClient 参数类型 */
function asClient(mock: ReturnType<typeof createMockPrisma>) {
  return mock as unknown as Parameters<typeof applySubscriptionChange>[1];
}

// ============================================================================
// 测试用例
// ============================================================================

async function run(): Promise<void> {
  console.log('\n=== apply-subscription-change.server.test.ts ===\n');

  // ------------------------------------------------------------------
  // 1. 升级 Starter 月付（首次付费）
  //    产生 MONTHLY_INCLUDED(150) + WELCOME(200)
  // ------------------------------------------------------------------
  {
    console.log('1. 升级 Starter 月付（首次付费）');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: null,
      existingBuckets: [false, false],
      createdBuckets: [
        {
          id: 'bucket-included',
          bucketType: 'MONTHLY_INCLUDED',
          amount: 150,
          cycleKey: 'STARTER:MONTHLY:2026-05',
        },
        {
          id: 'bucket-welcome',
          bucketType: 'WELCOME',
          amount: 200,
          cycleKey: 'WELCOME:FIRST_PAID',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-001',
        planKey: 'STARTER',
        interval: 'MONTHLY',
      },
      asClient(mock),
    );

    assertTrue(result.included !== null, 'included 不为 null');
    assertTrue(result.included!.created, 'included bucket 已创建');
    assertEqual(result.included!.bucketId, 'bucket-included', 'included bucketId');
    assertTrue(result.welcome !== null, 'welcome 不为 null');
    assertTrue(result.welcome!.created, 'welcome bucket 已创建');
    assertEqual(result.welcome!.bucketId, 'bucket-welcome', 'welcome bucketId');
    assertNull(result.freeMonthly, 'freeMonthly 为 null');
    assertTrue(result.incrementalScanEnabled, 'incrementalScanEnabled = true');

    // 验证 billingSubscription.update 被调用（开启增量扫描）
    const subUpdateCall = mock._calls.find(
      (c) => c.method === 'billingSubscription.update',
    );
    assertTrue(!!subUpdateCall, 'billingSubscription.update 被调用');
    assertEqual(
      subUpdateCall!.data.incrementalScanEnabled,
      true,
      'incrementalScanEnabled 设为 true',
    );

    // 验证 shop.update 被调用（设置 firstPaidBonusGrantedAt + incrementalScanEnabled）
    const shopUpdateCalls = mock._calls.filter((c) => c.method === 'shop.update');
    assertEqual(shopUpdateCalls.length, 2, 'shop.update 被调用 2 次');
    // 第一次：设置 firstPaidBonusGrantedAt
    assertTrue(
      shopUpdateCalls.some((c) => c.data.firstPaidBonusGrantedAt !== undefined),
      'firstPaidBonusGrantedAt 已设置',
    );
    // 第二次：设置 incrementalScanEnabled = true
    assertTrue(
      shopUpdateCalls.some((c) => c.data.incrementalScanEnabled === true),
      'shop.incrementalScanEnabled = true',
    );

    // 验证 included bucket 的 create 参数
    const includedCreate = mock._calls.find(
      (c) => c.method === 'creditBucket.create[0]',
    );
    assertTrue(!!includedCreate, 'included creditBucket.create 被调用');
    assertEqual(
      includedCreate!.data.bucketType,
      'MONTHLY_INCLUDED',
      'included bucketType = MONTHLY_INCLUDED',
    );
    assertEqual(includedCreate!.data.grantedAmount, 150, 'included amount = 150');
  }

  // ------------------------------------------------------------------
  // 2. 升级 Growth 年付（首次付费）
  //    产生 ANNUAL_INCLUDED(4200) + WELCOME(500)
  // ------------------------------------------------------------------
  {
    console.log('2. 升级 Growth 年付（首次付费）');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: null,
      existingBuckets: [false, false],
      createdBuckets: [
        {
          id: 'bucket-annual',
          bucketType: 'ANNUAL_INCLUDED',
          amount: 4200,
          cycleKey: 'GROWTH:ANNUAL:ext-sub-123',
        },
        {
          id: 'bucket-welcome-2',
          bucketType: 'WELCOME',
          amount: 500,
          cycleKey: 'WELCOME:FIRST_PAID',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-001',
        planKey: 'GROWTH',
        interval: 'ANNUAL',
        externalSubscriptionId: 'ext-sub-123',
      },
      asClient(mock),
    );

    assertTrue(result.included !== null, 'included 不为 null');
    assertTrue(result.included!.created, 'included bucket 已创建');
    assertEqual(result.included!.bucketId, 'bucket-annual', 'included bucketId');
    assertTrue(result.welcome !== null, 'welcome 不为 null');
    assertTrue(result.welcome!.created, 'welcome bucket 已创建');
    assertNull(result.freeMonthly, 'freeMonthly 为 null');
    assertTrue(result.incrementalScanEnabled, 'incrementalScanEnabled = true');

    // 验证 annual cycleKey 格式
    const annualCreate = mock._calls.find(
      (c) => c.method === 'creditBucket.create[0]',
    );
    assertTrue(!!annualCreate, 'annual creditBucket.create 被调用');
    assertEqual(
      annualCreate!.data.cycleKey,
      'GROWTH:ANNUAL:ext-sub-123',
      'annual cycleKey 格式 = GROWTH:ANNUAL:ext-sub-123',
    );
    assertEqual(
      annualCreate!.data.bucketType,
      'ANNUAL_INCLUDED',
      'annual bucketType = ANNUAL_INCLUDED',
    );
    assertEqual(annualCreate!.data.grantedAmount, 4200, 'annual amount = 4200');
  }

  // ------------------------------------------------------------------
  // 3. 再次升级不重复发放首次付费欢迎额度
  // ------------------------------------------------------------------
  {
    console.log('3. 再次升级不重复发放首次付费欢迎额度');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: new Date('2026-05-01T00:00:00Z'), // 已发放过
      existingBuckets: [false],
      createdBuckets: [
        {
          id: 'bucket-included-2',
          bucketType: 'MONTHLY_INCLUDED',
          amount: 350,
          cycleKey: 'GROWTH:MONTHLY:2026-05',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-002',
        planKey: 'GROWTH',
        interval: 'MONTHLY',
      },
      asClient(mock),
    );

    assertTrue(result.included !== null, 'included 不为 null');
    assertTrue(result.included!.created, 'included bucket 已创建');
    assertNull(result.welcome, 'welcome 为 null（不再发放）');
    assertNull(result.freeMonthly, 'freeMonthly 为 null');
    assertTrue(result.incrementalScanEnabled, 'incrementalScanEnabled = true');

    // 验证 shop.update 仅被调用一次（设置 incrementalScanEnabled，不再设置 firstPaidBonusGrantedAt）
    const shopUpdateCalls = mock._calls.filter((c) => c.method === 'shop.update');
    assertEqual(shopUpdateCalls.length, 1, 'shop.update 被调用 1 次（仅 incrementalScanEnabled）');
    assertEqual(
      shopUpdateCalls[0].data.incrementalScanEnabled,
      true,
      'shop.incrementalScanEnabled = true',
    );
    assertFalse(
      shopUpdateCalls.some((c) => c.data.firstPaidBonusGrantedAt !== undefined),
      '未设置 firstPaidBonusGrantedAt（非首次付费）',
    );
  }

  // ------------------------------------------------------------------
  // 4. 年付计划缺少 externalSubscriptionId 抛错
  // ------------------------------------------------------------------
  {
    console.log('4. 年付计划缺少 externalSubscriptionId 抛错');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: null,
      existingBuckets: [],
      createdBuckets: [],
    });

    await assertThrowsAsync(
      async () =>
        applySubscriptionChange(
          {
            shopId: 'shop-001',
            subscriptionId: 'sub-001',
            planKey: 'GROWTH',
            interval: 'ANNUAL',
            // externalSubscriptionId 未提供
          },
          asClient(mock),
        ),
      '年付缺少 externalSubscriptionId 应抛错',
    );
  }

  // ------------------------------------------------------------------
  // 5. 降级 Free - 关闭增量扫描 + 补发 FREE_MONTHLY_INCLUDED(25)
  // ------------------------------------------------------------------
  {
    console.log('5. 降级 Free');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: new Date(), // 不影响 Free 降级
      existingBuckets: [false],
      createdBuckets: [
        {
          id: 'bucket-free',
          bucketType: 'FREE_MONTHLY_INCLUDED',
          amount: 25,
          cycleKey: 'FREE:2026-05',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-free',
        planKey: 'FREE',
        interval: 'NONE',
      },
      asClient(mock),
    );

    assertNull(result.included, 'included 为 null');
    assertNull(result.welcome, 'welcome 为 null');
    assertTrue(result.freeMonthly !== null, 'freeMonthly 不为 null');
    assertTrue(result.freeMonthly!.created, 'freeMonthly bucket 已创建');
    assertEqual(result.freeMonthly!.bucketId, 'bucket-free', 'freeMonthly bucketId');
    assertFalse(result.incrementalScanEnabled, 'incrementalScanEnabled = false');

    // 验证 billingSubscription.update 关闭增量扫描
    const subUpdateCall = mock._calls.find(
      (c) => c.method === 'billingSubscription.update',
    );
    assertTrue(!!subUpdateCall, 'billingSubscription.update 被调用');
    assertEqual(
      subUpdateCall!.data.incrementalScanEnabled,
      false,
      'incrementalScanEnabled 设为 false',
    );

    // 验证 shop.update 关闭增量扫描（Shop 级冗余字段）
    const shopUpdateCall = mock._calls.find(
      (c) => c.method === 'shop.update' && c.data.incrementalScanEnabled === false,
    );
    assertTrue(!!shopUpdateCall, 'shop.update(incrementalScanEnabled=false) 被调用');

    // 验证 FREE_MONTHLY_INCLUDED 的 create 参数
    const freeCreate = mock._calls.find(
      (c) => c.method === 'creditBucket.create[0]',
    );
    assertTrue(!!freeCreate, 'free creditBucket.create 被调用');
    assertEqual(
      freeCreate!.data.bucketType,
      'FREE_MONTHLY_INCLUDED',
      'free bucketType = FREE_MONTHLY_INCLUDED',
    );
    assertEqual(freeCreate!.data.grantedAmount, 25, 'free amount = 25');
  }

  // ------------------------------------------------------------------
  // 6. 降级 Free 当月已有 Free bucket（幂等）
  // ------------------------------------------------------------------
  {
    console.log('6. 降级 Free 当月已有 Free bucket（幂等）');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: new Date(),
      existingBuckets: [true], // 已存在 → findUnique 返回已有 bucket
      createdBuckets: [
        {
          id: 'existing-free-bucket',
          bucketType: 'FREE_MONTHLY_INCLUDED',
          amount: 25,
          cycleKey: 'FREE:2026-05',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-free',
        planKey: 'FREE',
        interval: 'NONE',
      },
      asClient(mock),
    );

    assertTrue(result.freeMonthly !== null, 'freeMonthly 不为 null');
    assertFalse(
      result.freeMonthly!.created,
      'freeMonthly bucket 未重复创建（幂等）',
    );
    assertEqual(
      result.freeMonthly!.bucketId,
      'existing-free-bucket',
      'freeMonthly bucketId 指向已有 bucket',
    );
    assertFalse(result.incrementalScanEnabled, 'incrementalScanEnabled = false');

    // 验证 creditBucket.create 没有被调用
    const createCall = mock._calls.find(
      (c) => c.method === 'creditBucket.create[0]',
    );
    assertFalse(!!createCall, 'creditBucket.create 未被调用（幂等跳过）');
  }

  // ------------------------------------------------------------------
  // 7. 参数校验：shopId 为空抛错
  // ------------------------------------------------------------------
  {
    console.log('7. 参数校验：shopId 为空抛错');
    await assertThrowsAsync(
      async () =>
        applySubscriptionChange({
          shopId: '',
          subscriptionId: 'sub-001',
          planKey: 'FREE',
          interval: 'NONE',
        }),
      'shopId 为空应抛错',
    );
  }

  // ------------------------------------------------------------------
  // 8. 参数校验：subscriptionId 为空抛错
  // ------------------------------------------------------------------
  {
    console.log('8. 参数校验：subscriptionId 为空抛错');
    await assertThrowsAsync(
      async () =>
        applySubscriptionChange({
          shopId: 'shop-001',
          subscriptionId: '',
          planKey: 'FREE',
          interval: 'NONE',
        }),
      'subscriptionId 为空应抛错',
    );
  }

  // ------------------------------------------------------------------
  // 9. Free→Paid 联动：shop.incrementalScanEnabled 应变为 true
  //    模拟从 FREE 升级到 STARTER 月付（非首次付费）
  // ------------------------------------------------------------------
  {
    console.log('9. Free→Paid 联动：shop.incrementalScanEnabled 变为 true');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: new Date('2026-01-01T00:00:00Z'), // 已发放过
      existingBuckets: [false],
      createdBuckets: [
        {
          id: 'bucket-included-9',
          bucketType: 'MONTHLY_INCLUDED',
          amount: 150,
          cycleKey: 'STARTER:MONTHLY:2026-05',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-upgrade',
        planKey: 'STARTER',
        interval: 'MONTHLY',
      },
      asClient(mock),
    );

    assertTrue(result.incrementalScanEnabled, 'result.incrementalScanEnabled = true');

    // 验证 billingSubscription.update 设置 true
    const subUpdate = mock._calls.find(
      (c) => c.method === 'billingSubscription.update',
    );
    assertTrue(!!subUpdate, 'billingSubscription.update 被调用');
    assertEqual(subUpdate!.data.incrementalScanEnabled, true, 'sub.incrementalScanEnabled = true');

    // 验证 shop.update 设置 true
    const shopUpdate = mock._calls.find(
      (c) => c.method === 'shop.update' && c.data.incrementalScanEnabled === true,
    );
    assertTrue(!!shopUpdate, 'shop.update(incrementalScanEnabled=true) 被调用');
  }

  // ------------------------------------------------------------------
  // 10. Paid→Free 联动：shop.incrementalScanEnabled 应变为 false
  //     模拟从 STARTER 降级到 FREE
  // ------------------------------------------------------------------
  {
    console.log('10. Paid→Free 联动：shop.incrementalScanEnabled 变为 false');
    const mock = createMockPrisma({
      firstPaidBonusGrantedAt: new Date('2026-01-01T00:00:00Z'),
      existingBuckets: [false],
      createdBuckets: [
        {
          id: 'bucket-free-10',
          bucketType: 'FREE_MONTHLY_INCLUDED',
          amount: 25,
          cycleKey: 'FREE:2026-05',
        },
      ],
    });

    const result = await applySubscriptionChange(
      {
        shopId: 'shop-001',
        subscriptionId: 'sub-downgrade',
        planKey: 'FREE',
        interval: 'NONE',
      },
      asClient(mock),
    );

    assertFalse(result.incrementalScanEnabled, 'result.incrementalScanEnabled = false');

    // 验证 billingSubscription.update 设置 false
    const subUpdate = mock._calls.find(
      (c) => c.method === 'billingSubscription.update',
    );
    assertTrue(!!subUpdate, 'billingSubscription.update 被调用');
    assertEqual(subUpdate!.data.incrementalScanEnabled, false, 'sub.incrementalScanEnabled = false');

    // 验证 shop.update 设置 false
    const shopUpdate = mock._calls.find(
      (c) => c.method === 'shop.update' && c.data.incrementalScanEnabled === false,
    );
    assertTrue(!!shopUpdate, 'shop.update(incrementalScanEnabled=false) 被调用');
  }

  // ------------------------------------------------------------------
  // 汇总
  // ------------------------------------------------------------------
  console.log(`\n  总计: ${passed + failed}  通过: ${passed}  失败: ${failed}\n`);
  if (failures.length > 0) {
    console.error('  失败详情:');
    failures.forEach((f) => console.error(`    - ${f}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
