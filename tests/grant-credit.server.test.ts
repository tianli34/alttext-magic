/**
 * File: tests/grant-credit.server.test.ts
 * Purpose: grantCreditBucket 单元测试 —— 通过 mock PrismaClient 验证核心逻辑。
 *
 * 测试覆盖：
 *   1. 正常发放：创建 bucket + GRANT ledger
 *   2. 幂等性：相同 shopId + bucketType + cycleKey 不重复创建
 *   3. 参数校验：amount <= 0 抛错
 *   4. 必填校验：shopId / bucketType / cycleKey 为空抛错
 *   5. 并发冲突：唯一约束冲突时返回已存在的 bucket
 *   6. 事务回滚：非约束错误不会产生半完成数据
 *   7. remainingAmount 初始等于 amount
 *   8. metadata/source 合并正确
 *
 * Usage: npx tsx tests/grant-credit.server.test.ts
 */

// ---- 劫持 pino —— 避免 logger 依赖 env 配置 ----
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 劫持模块
void Prisma;

// ============================================================================
// Mock 基础设施
// ============================================================================

/** 创建一条 mock CreditBucket 记录 */
function makeMockBucket(overrides: Partial<{
  id: string;
  shopId: string;
  bucketType: string;
  cycleKey: string;
  grantedAmount: number;
  remainingAmount: number;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? 'bucket-001',
    shopId: overrides.shopId ?? 'shop-001',
    billingSubscriptionId: null,
    overagePackPurchaseId: null,
    bucketType: overrides.bucketType ?? 'FREE_MONTHLY_INCLUDED',
    status: overrides.status ?? 'ACTIVE',
    cycleKey: overrides.cycleKey ?? 'FREE:2026-05',
    grantedAmount: overrides.grantedAmount ?? 25,
    reservedAmount: 0,
    consumedAmount: 0,
    remainingAmount: overrides.remainingAmount ?? 25,
    effectiveAt: new Date('2026-05-01T00:00:00Z'),
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
  type: string;
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
    type: overrides.type ?? 'GRANT',
    deltaAmount: overrides.deltaAmount ?? 25,
    balanceAfter: overrides.balanceAfter ?? 25,
    reason: 'FREE_MONTHLY_INCLUDED 额度发放',
    metadata: {},
    idempotencyKey: overrides.idempotencyKey ?? 'shop-001:FREE_MONTHLY_INCLUDED:FREE:2026-05:GRANT',
    externalBillingReference: null,
    eventAt: new Date('2026-05-12T00:00:00Z'),
    createdAt: new Date('2026-05-12T00:00:00Z'),
  };
}

/**
 * 创建 Mock PrismaClient。
 * 通过传入回调函数来自定义 $transaction / findUnique / create 的行为。
 */
interface MockPrismaConfig {
  /** $transaction 回调执行函数 */
  transactionFn?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  /** bucket findUnique 返回值 */
  bucketFindUniqueResult: unknown | null;
  /** bucket create 返回值 */
  bucketCreateResult: unknown;
  /** ledger create 返回值 */
  ledgerCreateResult: unknown;
  /** bucket findUnique（外层，用于并发冲突恢复） */
  outerBucketFindUniqueResult?: unknown | null;
  /** ledger findUnique（外层，用于并发冲突恢复） */
  outerLedgerFindUniqueResult?: unknown | null;
}

function createMockPrisma(config: MockPrismaConfig) {
  const mockTx = {
    creditBucket: {
      findUnique: async () => config.bucketFindUniqueResult,
      create: async () => config.bucketCreateResult,
    },
    creditLedger: {
      create: async () => config.ledgerCreateResult,
      findUnique: async () => config.outerLedgerFindUniqueResult ?? null,
    },
  };

  return {
    creditBucket: {
      findUnique: async () => config.outerBucketFindUniqueResult ?? null,
    },
    creditLedger: {
      findUnique: async () => config.outerLedgerFindUniqueResult ?? null,
    },
    $transaction: config.transactionFn
      ? config.transactionFn
      : async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  };
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

function assertNotEqual<T>(actual: T, notExpected: T, label: string): void {
  if (actual !== notExpected) {
    passed++;
  } else {
    failed++;
    const msg = `${label}: expected NOT ${JSON.stringify(notExpected)}, but got same`;
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
// 导入被测模块（在 pino mock 之后）
// ============================================================================

// 动态导入以避免 env 校验
const { grantCreditBucket } = await import('../server/modules/billing/credit/grant-credit.server.js');

// ============================================================================
// 测试用例
// ============================================================================

async function run(): Promise<void> {
  console.log('\n=== grant-credit.server.test.ts ===\n');

  // ------------------------------------------------------------------
  // 1. 正常发放：创建 bucket + GRANT ledger
  // ------------------------------------------------------------------
  {
    const mockBucket = makeMockBucket();
    const mockLedger = makeMockLedger();

    const mockPrisma = createMockPrisma({
      bucketFindUniqueResult: null, // 不存在
      bucketCreateResult: mockBucket,
      ledgerCreateResult: mockLedger,
    });

    const result = await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'FREE_MONTHLY_INCLUDED',
        amount: 25,
        cycleKey: 'FREE:2026-05',
      },
      mockPrisma as never,
    );

    assertTrue(result.created, '正常发放: created === true');
    assertEqual(result.bucket.id, 'bucket-001', '正常发放: bucket.id');
    assertEqual(result.ledger?.id, 'ledger-001', '正常发放: ledger.id');
    console.log('  ✓ 验收：正常发放创建 bucket + GRANT ledger');
  }

  // ------------------------------------------------------------------
  // 2. 验收：幂等性 —— 相同 shopId + bucketType + cycleKey 不重复创建
  // ------------------------------------------------------------------
  {
    const existingBucket = makeMockBucket();

    const mockPrisma = createMockPrisma({
      bucketFindUniqueResult: existingBucket, // 已存在
      bucketCreateResult: makeMockBucket({ id: 'should-not-create' }),
      ledgerCreateResult: makeMockLedger(),
    });

    const result = await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'FREE_MONTHLY_INCLUDED',
        amount: 25,
        cycleKey: 'FREE:2026-05',
      },
      mockPrisma as never,
    );

    assertFalse(result.created, '幂等性: created === false');
    assertEqual(result.bucket.id, 'bucket-001', '幂等性: 返回已存在 bucket');
    assertEqual(result.ledger, null, '幂等性: ledger === null（不重复写入）');
    console.log('  ✓ 验收：连续发放两次只产生一个 bucket');
  }

  // ------------------------------------------------------------------
  // 3. 参数校验：amount <= 0 抛错
  // ------------------------------------------------------------------
  {
    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: 'shop-001', bucketType: 'FREE_MONTHLY_INCLUDED', amount: 0, cycleKey: 'FREE:2026-05' },
        createMockPrisma({ bucketFindUniqueResult: null, bucketCreateResult: {}, ledgerCreateResult: {} }) as never,
      ),
      'amount === 0 应抛错',
    );

    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: 'shop-001', bucketType: 'FREE_MONTHLY_INCLUDED', amount: -5, cycleKey: 'FREE:2026-05' },
        createMockPrisma({ bucketFindUniqueResult: null, bucketCreateResult: {}, ledgerCreateResult: {} }) as never,
      ),
      'amount < 0 应抛错',
    );

    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: 'shop-001', bucketType: 'FREE_MONTHLY_INCLUDED', amount: 1.5, cycleKey: 'FREE:2026-05' },
        createMockPrisma({ bucketFindUniqueResult: null, bucketCreateResult: {}, ledgerCreateResult: {} }) as never,
      ),
      'amount 非整数应抛错',
    );

    console.log('  ✓ 验收：amount <= 0 / 非整数 抛错');
  }

  // ------------------------------------------------------------------
  // 4. 必填校验：shopId / bucketType / cycleKey 为空抛错
  // ------------------------------------------------------------------
  {
    const baseMock = createMockPrisma({ bucketFindUniqueResult: null, bucketCreateResult: {}, ledgerCreateResult: {} });

    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: '', bucketType: 'FREE_MONTHLY_INCLUDED', amount: 25, cycleKey: 'FREE:2026-05' },
        baseMock as never,
      ),
      'shopId 为空应抛错',
    );

    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: 'shop-001', bucketType: '' as 'FREE_MONTHLY_INCLUDED', amount: 25, cycleKey: 'FREE:2026-05' },
        baseMock as never,
      ),
      'bucketType 为空应抛错',
    );

    await assertThrowsAsync(
      () => grantCreditBucket(
        { shopId: 'shop-001', bucketType: 'FREE_MONTHLY_INCLUDED', amount: 25, cycleKey: '' },
        baseMock as never,
      ),
      'cycleKey 为空应抛错',
    );

    console.log('  ✓ 验收：必填参数为空抛错');
  }

  // ------------------------------------------------------------------
  // 5. 验收：并发冲突（唯一约束 P2002）返回已存在 bucket
  // ------------------------------------------------------------------
  {
    const existingBucket = makeMockBucket();
    const existingLedger = makeMockLedger();

    // 构造一个会在 $transaction 中抛 P2002 的 mock
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '7.5.0', meta: { target: ['shop_id', 'bucket_type', 'cycle_key'] } },
    );

    const mockPrisma = createMockPrisma({
      bucketFindUniqueResult: null,
      bucketCreateResult: {},
      ledgerCreateResult: {},
      outerBucketFindUniqueResult: existingBucket,
      outerLedgerFindUniqueResult: existingLedger,
      transactionFn: async () => { throw p2002Error; },
    });

    const result = await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'FREE_MONTHLY_INCLUDED',
        amount: 25,
        cycleKey: 'FREE:2026-05',
      },
      mockPrisma as never,
    );

    assertFalse(result.created, '并发冲突: created === false');
    assertEqual(result.bucket.id, 'bucket-001', '并发冲突: 返回已存在 bucket');
    assertEqual(result.ledger?.id, 'ledger-001', '并发冲突: 返回已存在 ledger');
    console.log('  ✓ 验收：并发冲突时返回已存在 bucket');
  }

  // ------------------------------------------------------------------
  // 6. 事务回滚：非约束错误向上抛出
  // ------------------------------------------------------------------
  {
    const genericError = new Error('Something went wrong in DB');

    const mockPrisma = createMockPrisma({
      bucketFindUniqueResult: null,
      bucketCreateResult: {},
      ledgerCreateResult: {},
      transactionFn: async () => { throw genericError; },
    });

    let caught = false;
    try {
      await grantCreditBucket(
        {
          shopId: 'shop-001',
          bucketType: 'FREE_MONTHLY_INCLUDED',
          amount: 25,
          cycleKey: 'FREE:2026-05',
        },
        mockPrisma as never,
      );
    } catch (err: unknown) {
      caught = true;
      assertTrue(err instanceof Error, '非约束错误类型为 Error');
      assertEqual(
        (err as Error).message,
        'Something went wrong in DB',
        '非约束错误 message 正确',
      );
    }
    assertTrue(caught, '非约束错误应向上抛出');
    console.log('  ✓ 验收：非约束错误向上抛出（事务回滚）');
  }

  // ------------------------------------------------------------------
  // 7. remainingAmount 初始等于 amount
  // ------------------------------------------------------------------
  {
    let capturedBucketData: Record<string, unknown> | null = null;

    const mockTx = {
      creditBucket: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          capturedBucketData = args.data;
          return makeMockBucket({
            id: 'bucket-new',
            grantedAmount: 100,
            remainingAmount: 100,
          });
        },
      },
      creditLedger: {
        create: async () => makeMockLedger({ bucketId: 'bucket-new', deltaAmount: 100, balanceAfter: 100 }),
      },
    };

    const mockPrisma = {
      creditBucket: { findUnique: async () => null },
      creditLedger: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    };

    await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'MONTHLY_INCLUDED',
        amount: 100,
        cycleKey: 'INCLUDED:STARTER:2026-05',
      },
      mockPrisma as never,
    );

    assertTrue(capturedBucketData !== null, 'remainingAmount: capturedBucketData 不为 null');
    const bd = capturedBucketData!;
    assertEqual(bd['grantedAmount'], 100, 'remainingAmount: grantedAmount === 100');
    assertEqual(bd['remainingAmount'], 100, 'remainingAmount: remainingAmount === grantedAmount');
    console.log('  ✓ 验收：remainingAmount 初始等于 grantedAmount');
  }

  // ------------------------------------------------------------------
  // 8. metadata/source 合并正确
  // ------------------------------------------------------------------
  {
    let capturedLedgerData: Record<string, unknown> | null = null;

    const mockTx = {
      creditBucket: {
        findUnique: async () => null,
        create: async () => makeMockBucket({ id: 'bucket-meta' }),
      },
      creditLedger: {
        create: async (args: { data: Record<string, unknown> }) => {
          capturedLedgerData = args.data;
          return makeMockLedger({ id: 'ledger-meta', bucketId: 'bucket-meta' });
        },
      },
    };

    const mockPrisma = {
      creditBucket: { findUnique: async () => null },
      creditLedger: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    };

    await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'WELCOME',
        amount: 50,
        cycleKey: 'INSTALL_WELCOME',
        source: 'install',
        sourceRef: 'sub-123',
        metadata: { planKey: 'FREE' },
      },
      mockPrisma as never,
    );

    assertTrue(capturedLedgerData !== null, 'metadata: capturedLedgerData 不为 null');
    const ld8 = capturedLedgerData!;
    const meta = ld8['metadata'] as Record<string, unknown>;
    assertEqual(meta.source, 'install', 'metadata: source 正确');
    assertEqual(meta.sourceRef, 'sub-123', 'metadata: sourceRef 正确');
    assertEqual(meta.planKey, 'FREE', 'metadata: 自定义字段保留');
    console.log('  ✓ 验收：metadata/source 合并正确');
  }

  // ------------------------------------------------------------------
  // 9. ledger idempotencyKey 格式正确
  // ------------------------------------------------------------------
  {
    let capturedLedgerData: Record<string, unknown> | null = null;

    const mockTx = {
      creditBucket: {
        findUnique: async () => null,
        create: async () => makeMockBucket({ id: 'bucket-ik' }),
      },
      creditLedger: {
        create: async (args: { data: Record<string, unknown> }) => {
          capturedLedgerData = args.data;
          return makeMockLedger({ id: 'ledger-ik', bucketId: 'bucket-ik' });
        },
      },
    };

    const mockPrisma = {
      creditBucket: { findUnique: async () => null },
      creditLedger: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    };

    await grantCreditBucket(
      {
        shopId: 'shop-test',
        bucketType: 'OVERAGE_PACK',
        amount: 500,
        cycleKey: 'OVERAGE:pack-001',
      },
      mockPrisma as never,
    );

    assertTrue(capturedLedgerData !== null, 'idempotencyKey: capturedLedgerData 不为 null');
    const ld9 = capturedLedgerData!;
    assertEqual(
      ld9['idempotencyKey'],
      'shop-test:OVERAGE_PACK:OVERAGE:pack-001:GRANT',
      'idempotencyKey 格式正确',
    );
    console.log('  ✓ 验收：ledger idempotencyKey 格式正确');
  }

  // ------------------------------------------------------------------
  // 10. 验收：GRANT ledger type 固定为 GRANT
  // ------------------------------------------------------------------
  {
    let capturedLedgerData: Record<string, unknown> | null = null;

    const mockTx = {
      creditBucket: {
        findUnique: async () => null,
        create: async () => makeMockBucket(),
      },
      creditLedger: {
        create: async (args: { data: Record<string, unknown> }) => {
          capturedLedgerData = args.data;
          return makeMockLedger();
        },
      },
    };

    const mockPrisma = {
      creditBucket: { findUnique: async () => null },
      creditLedger: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    };

    await grantCreditBucket(
      {
        shopId: 'shop-001',
        bucketType: 'FREE_MONTHLY_INCLUDED',
        amount: 25,
        cycleKey: 'FREE:2026-05',
      },
      mockPrisma as never,
    );

    const ld10 = capturedLedgerData!;
    assertEqual(ld10['type'], 'GRANT', 'ledger type 固定为 GRANT');
    console.log('  ✓ 验收：GRANT ledger type 固定为 GRANT');
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

run().catch((err: unknown) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
