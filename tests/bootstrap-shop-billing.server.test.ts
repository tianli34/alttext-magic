/**
 * File: tests/bootstrap-shop-billing.server.test.ts
 * Purpose: bootstrapShopBilling 单元测试 —— 通过 mock PrismaClient + grantCreditBucket 验证核心逻辑。
 *
 * 测试覆盖：
 *   1. 正常初始化：创建 billing_subscription + WELCOME(50) + FREE_MONTHLY_INCLUDED(25)
 *   2. 幂等性 - 订阅已存在：跳过 subscription 创建，仅发放额度
 *   3. 幂等性 - 全量重复调用：所有步骤均不重复
 *   4. 参数校验：shopId 为空抛错
 *   5. 验证 billing_subscription 字段正确（FREE, NONE, ACTIVE, incrementalScanEnabled=false）
 *   6. 验证 WELCOME bucket 的 cycleKey 为 "WELCOME:INSTALL"
 *   7. 验证 FREE_MONTHLY_INCLUDED bucket 的 cycleKey 格式为 "FREE:YYYY-MM"
 *
 * Usage: npx tsx tests/bootstrap-shop-billing.server.test.ts
 */

import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 劫持模块
void Prisma;

// ============================================================================
// Mock 基础设施
// ============================================================================

/** 创建一条 mock BillingSubscription 记录 */
function makeMockSubscription(overrides: Partial<{
  id: string;
  shopId: string;
  planCode: string;
  billingInterval: string;
  status: string;
  incrementalScanEnabled: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'sub-001',
    shopId: overrides.shopId ?? 'shop-001',
    planCode: overrides.planCode ?? 'FREE',
    billingInterval: overrides.billingInterval ?? 'NONE',
    status: overrides.status ?? 'ACTIVE',
    externalSubscriptionId: null,
    externalBillingReference: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    firstPaidWelcomeGrantedAt: null,
    incrementalScanEnabled: overrides.incrementalScanEnabled ?? false,
    activatedAt: new Date('2026-05-12T00:00:00Z'),
    canceledAt: null,
    expiresAt: null,
    createdAt: new Date('2026-05-12T00:00:00Z'),
    updatedAt: new Date('2026-05-12T00:00:00Z'),
  };
}

/** 创建一条 mock CreditBucket 记录 */
function makeMockBucket(overrides: Partial<{
  id: string;
  shopId: string;
  bucketType: string;
  cycleKey: string;
  grantedAmount: number;
  remainingAmount: number;
  billingSubscriptionId: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'bucket-001',
    shopId: overrides.shopId ?? 'shop-001',
    billingSubscriptionId: overrides.billingSubscriptionId ?? 'sub-001',
    overagePackPurchaseId: null,
    bucketType: overrides.bucketType ?? 'WELCOME',
    status: 'ACTIVE',
    cycleKey: overrides.cycleKey ?? 'WELCOME:INSTALL',
    grantedAmount: overrides.grantedAmount ?? 50,
    reservedAmount: 0,
    consumedAmount: 0,
    remainingAmount: overrides.remainingAmount ?? 50,
    effectiveAt: new Date('2026-05-12T00:00:00Z'),
    expiresAt: null,
    activatedAt: new Date('2026-05-12T00:00:00Z'),
    exhaustedAt: null,
    createdAt: new Date('2026-05-12T00:00:00Z'),
    updatedAt: new Date('2026-05-12T00:00:00Z'),
  };
}

/** 创建一条 mock CreditLedger 记录 */
function makeMockLedger(overrides: Partial<{
  id: string;
  shopId: string;
  bucketId: string;
  deltaAmount: number;
  balanceAfter: number;
  idempotencyKey: string;
}> = {}) {
  return {
    id: overrides.id ?? 'ledger-001',
    shopId: overrides.shopId ?? 'shop-001',
    bucketId: overrides.bucketId ?? 'bucket-001',
    reservationId: null,
    reservationLineId: null,
    jobBatchId: null,
    type: 'GRANT',
    deltaAmount: overrides.deltaAmount ?? 50,
    balanceAfter: overrides.balanceAfter ?? 50,
    reason: '安装欢迎额度',
    metadata: { source: 'install' },
    idempotencyKey: overrides.idempotencyKey ?? 'shop-001:WELCOME:WELCOME:INSTALL:GRANT',
    externalBillingReference: null,
    eventAt: new Date('2026-05-12T00:00:00Z'),
    createdAt: new Date('2026-05-12T00:00:00Z'),
  };
}

// ============================================================================
// Mock PrismaClient 构造器
// ============================================================================

interface MockPrismaConfig {
  /** billingSubscription.findFirst 返回值 */
  subFindFirstResult: unknown | null;
  /** billingSubscription.create 返回值 */
  subCreateResult: unknown;
  /** grantCreditBucket 的事务中 bucket findUnique 返回值列表（按调用顺序） */
  bucketFindUniqueResults: (unknown | null)[];
  /** grantCreditBucket 的事务中 bucket create 返回值列表 */
  bucketCreateResults: unknown[];
  /** grantCreditBucket 的事务中 ledger create 返回值列表 */
  ledgerCreateResults: unknown[];
}

function createMockPrismaClient(config: MockPrismaConfig) {
  let findUniqueIndex = 0;
  let createIndex = 0;

  const mockTx = {
    creditBucket: {
      findUnique: async () => {
        const result = config.bucketFindUniqueResults[findUniqueIndex] ?? null;
        findUniqueIndex++;
        return result;
      },
      create: async () => {
        const result = config.bucketCreateResults[createIndex];
        createIndex++;
        return result;
      },
    },
    creditLedger: {
      create: async () => {
        return config.ledgerCreateResults[createIndex - 1] ?? makeMockLedger();
      },
    },
  };

  return {
    billingSubscription: {
      findFirst: async () => config.subFindFirstResult,
      create: async () => config.subCreateResult,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(mockTx);
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

// ============================================================================
// 导入被测模块（在 mock 基础设施之后）
// ============================================================================

// 注意：由于 bootstrapShopBilling 使用了动态 import 加载 PrismaClient，
// 在测试中我们直接传入 client 参数来避免动态 import。

const { bootstrapShopBilling } = await import('../server/modules/billing/bootstrap-shop-billing.server.js');

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
    console.log(`  ❌ ${name}`);
    console.log(`     ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`断言失败: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
}

// ============================================================================
// 测试用例
// ============================================================================

console.log('\n🧪 bootstrapShopBilling 测试套件\n');

// ---- 测试 1：正常初始化 ----
await test('正常初始化：创建 subscription + WELCOME(50) + FREE_MONTHLY_INCLUDED(25)', async () => {
  const mockSub = makeMockSubscription({ id: 'sub-new' });
  const mockWelcomeBucket = makeMockBucket({
    id: 'bucket-welcome',
    bucketType: 'WELCOME',
    cycleKey: 'WELCOME:INSTALL',
    grantedAmount: 50,
    remainingAmount: 50,
    billingSubscriptionId: 'sub-new',
  });
  const mockMonthlyBucket = makeMockBucket({
    id: 'bucket-monthly',
    bucketType: 'FREE_MONTHLY_INCLUDED',
    cycleKey: 'FREE:2026-05',
    grantedAmount: 25,
    remainingAmount: 25,
    billingSubscriptionId: 'sub-new',
  });
  const mockWelcomeLedger = makeMockLedger({
    id: 'ledger-welcome',
    bucketId: 'bucket-welcome',
    deltaAmount: 50,
    balanceAfter: 50,
  });
  const mockMonthlyLedger = makeMockLedger({
    id: 'ledger-monthly',
    bucketId: 'bucket-monthly',
    deltaAmount: 25,
    balanceAfter: 25,
  });

  const client = createMockPrismaClient({
    subFindFirstResult: null, // 订阅不存在
    subCreateResult: mockSub,
    bucketFindUniqueResults: [null, null], // 两个 bucket 都不存在
    bucketCreateResults: [mockWelcomeBucket, mockMonthlyBucket],
    ledgerCreateResults: [mockWelcomeLedger, mockMonthlyLedger],
  });

  const result = await bootstrapShopBilling('shop-001', client);

  assertEqual(result.subscriptionId, 'sub-new', 'subscriptionId');
  assertEqual(result.subscriptionCreated, true, 'subscriptionCreated');
  assertEqual(result.welcome.created, true, 'welcome.created');
  assertEqual(result.welcome.bucketId, 'bucket-welcome', 'welcome.bucketId');
  assertEqual(result.monthly.created, true, 'monthly.created');
  assertEqual(result.monthly.bucketId, 'bucket-monthly', 'monthly.bucketId');
});

// ---- 测试 2：幂等性 - 订阅已存在 ----
await test('幂等性：订阅已存在时跳过创建', async () => {
  const existingSub = makeMockSubscription({ id: 'sub-exist' });
  const mockWelcomeBucket = makeMockBucket({
    id: 'bucket-welcome-exist',
    bucketType: 'WELCOME',
  });
  const mockMonthlyBucket = makeMockBucket({
    id: 'bucket-monthly-exist',
    bucketType: 'FREE_MONTHLY_INCLUDED',
    cycleKey: 'FREE:2026-05',
    grantedAmount: 25,
    remainingAmount: 25,
  });

  const client = createMockPrismaClient({
    subFindFirstResult: existingSub, // 订阅已存在
    subCreateResult: makeMockSubscription(),
    bucketFindUniqueResults: [null, null],
    bucketCreateResults: [mockWelcomeBucket, mockMonthlyBucket],
    ledgerCreateResults: [
      makeMockLedger({ bucketId: 'bucket-welcome-exist' }),
      makeMockLedger({ bucketId: 'bucket-monthly-exist', deltaAmount: 25, balanceAfter: 25 }),
    ],
  });

  const result = await bootstrapShopBilling('shop-001', client);

  assertEqual(result.subscriptionId, 'sub-exist', 'subscriptionId 应为已存在的');
  assertEqual(result.subscriptionCreated, false, 'subscriptionCreated 应为 false');
});

// ---- 测试 3：幂等性 - 全量重复调用 ----
await test('幂等性：全量重复调用（bucket 已存在）', async () => {
  const existingSub = makeMockSubscription({ id: 'sub-exist-2' });
  const existingWelcomeBucket = makeMockBucket({
    id: 'bucket-welcome-exist-2',
    bucketType: 'WELCOME',
  });
  const existingMonthlyBucket = makeMockBucket({
    id: 'bucket-monthly-exist-2',
    bucketType: 'FREE_MONTHLY_INCLUDED',
    cycleKey: 'FREE:2026-05',
    grantedAmount: 25,
    remainingAmount: 25,
  });

  const client = createMockPrismaClient({
    subFindFirstResult: existingSub,
    subCreateResult: makeMockSubscription(),
    // 两个 bucket 都已存在（findUnique 返回非 null）
    bucketFindUniqueResults: [existingWelcomeBucket, existingMonthlyBucket],
    bucketCreateResults: [],
    ledgerCreateResults: [],
  });

  const result = await bootstrapShopBilling('shop-001', client);

  assertEqual(result.subscriptionCreated, false, 'subscriptionCreated 应为 false');
  assertEqual(result.welcome.created, false, 'welcome.created 应为 false');
  assertEqual(result.monthly.created, false, 'monthly.created 应为 false');
  assertEqual(result.welcome.bucketId, 'bucket-welcome-exist-2', 'welcome.bucketId');
  assertEqual(result.monthly.bucketId, 'bucket-monthly-exist-2', 'monthly.bucketId');
});

// ---- 测试 4：参数校验 ----
await test('参数校验：shopId 为空抛错', async () => {
  let errorThrown = false;
  try {
    await bootstrapShopBilling('', createMockPrismaClient({
      subFindFirstResult: null,
      subCreateResult: makeMockSubscription(),
      bucketFindUniqueResults: [],
      bucketCreateResults: [],
      ledgerCreateResults: [],
    }));
  } catch (err) {
    errorThrown = true;
    assert(
      err instanceof Error && err.message.includes('shopId 不能为空'),
      '错误信息应包含 "shopId 不能为空"',
    );
  }
  assert(errorThrown, '应抛出错误');
});

// ---- 测试 5：验证 subscription 创建参数 ----
await test('验证 billing_subscription 创建参数正确', async () => {
  let createData: Record<string, unknown> | null = null;

  const mockSub = makeMockSubscription({ id: 'sub-verify' });
  const mockWelcomeBucket = makeMockBucket({ id: 'b-w' });
  const mockMonthlyBucket = makeMockBucket({ id: 'b-m', bucketType: 'FREE_MONTHLY_INCLUDED', grantedAmount: 25, remainingAmount: 25 });

  const client = {
    billingSubscription: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        createData = args.data;
        return mockSub;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        creditBucket: {
          findUnique: async () => null,
          create: async (args: { data: Record<string, unknown> }) => {
            if ((args.data as { bucketType: string }).bucketType === 'WELCOME') {
              return mockWelcomeBucket;
            }
            return mockMonthlyBucket;
          },
        },
        creditLedger: {
          create: async () => makeMockLedger(),
        },
      };
      return fn(mockTx);
    },
  } as unknown as import('@prisma/client').PrismaClient;

  await bootstrapShopBilling('shop-verify', client);

  assert(createData !== null, 'createData 应被设置');
  assertEqual(createData!.shopId, 'shop-verify', 'shopId');
  assertEqual(createData!.planCode, 'FREE', 'planCode');
  assertEqual(createData!.billingInterval, 'NONE', 'billingInterval');
  assertEqual(createData!.status, 'ACTIVE', 'status');
  assertEqual(createData!.incrementalScanEnabled, false, 'incrementalScanEnabled');
  assert(createData!.activatedAt instanceof Date, 'activatedAt 应为 Date');
});

// ---- 测试 6：验证 WELCOME bucket 的 cycleKey ----
await test('验证 WELCOME bucket 的 cycleKey 为 "WELCOME:INSTALL"', async () => {
  const mockSub = makeMockSubscription();
  let welcomeBucketData: Record<string, unknown> | null = null;

  const mockWelcomeBucket = makeMockBucket({ id: 'b-cycle-w' });
  const mockMonthlyBucket = makeMockBucket({ id: 'b-cycle-m', bucketType: 'FREE_MONTHLY_INCLUDED', grantedAmount: 25, remainingAmount: 25 });

  const client = {
    billingSubscription: {
      findFirst: async () => null,
      create: async () => mockSub,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        creditBucket: {
          findUnique: async () => null,
          create: async (args: { data: Record<string, unknown> }) => {
            if ((args.data as { bucketType: string }).bucketType === 'WELCOME') {
              welcomeBucketData = args.data;
              return mockWelcomeBucket;
            }
            return mockMonthlyBucket;
          },
        },
        creditLedger: {
          create: async () => makeMockLedger(),
        },
      };
      return fn(mockTx);
    },
  } as unknown as import('@prisma/client').PrismaClient;

  await bootstrapShopBilling('shop-001', client);

  assert(welcomeBucketData !== null, 'welcomeBucketData 应被设置');
  assertEqual(welcomeBucketData!.cycleKey, 'WELCOME:INSTALL', 'WELCOME cycleKey');
  assertEqual(welcomeBucketData!.grantedAmount, 50, 'WELCOME amount');
  assertEqual(welcomeBucketData!.remainingAmount, 50, 'WELCOME remainingAmount');
});

// ---- 测试 7：验证 FREE_MONTHLY_INCLUDED bucket 的 cycleKey 格式 ----
await test('验证 FREE_MONTHLY_INCLUDED bucket 的 cycleKey 格式为 "FREE:YYYY-MM"', async () => {
  const mockSub = makeMockSubscription();
  let monthlyBucketData: Record<string, unknown> | null = null;

  const mockWelcomeBucket = makeMockBucket({ id: 'b-w2' });
  const mockMonthlyBucket = makeMockBucket({ id: 'b-m2', bucketType: 'FREE_MONTHLY_INCLUDED', grantedAmount: 25, remainingAmount: 25 });

  const client = {
    billingSubscription: {
      findFirst: async () => null,
      create: async () => mockSub,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        creditBucket: {
          findUnique: async () => null,
          create: async (args: { data: Record<string, unknown> }) => {
            if ((args.data as { bucketType: string }).bucketType === 'FREE_MONTHLY_INCLUDED') {
              monthlyBucketData = args.data;
              return mockMonthlyBucket;
            }
            return mockWelcomeBucket;
          },
        },
        creditLedger: {
          create: async () => makeMockLedger(),
        },
      };
      return fn(mockTx);
    },
  } as unknown as import('@prisma/client').PrismaClient;

  await bootstrapShopBilling('shop-001', client);

  assert(monthlyBucketData !== null, 'monthlyBucketData 应被设置');
  const cycleKey = monthlyBucketData!.cycleKey as string;
  // 验证 cycleKey 格式为 FREE:YYYY-MM
  assert(/^FREE:\d{4}-\d{2}$/.test(cycleKey), `cycleKey "${cycleKey}" 应匹配 FREE:YYYY-MM 格式`);
  assertEqual(monthlyBucketData!.grantedAmount, 25, 'FREE_MONTHLY_INCLUDED amount');
  assertEqual(monthlyBucketData!.remainingAmount, 25, 'FREE_MONTHLY_INCLUDED remainingAmount');
  // 验证 expiresAt 为下月 1 号
  const expiresAt = monthlyBucketData!.expiresAt as Date;
  assert(expiresAt instanceof Date, 'expiresAt 应为 Date');
  assertEqual(expiresAt.getUTCDate(), 1, 'expiresAt 应为某月 1 号');
});

// ============================================================================
// 结果
// ============================================================================

console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) {
  process.exit(1);
}
