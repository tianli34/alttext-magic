/**
 * File: tests/credit-reservation.server.test.ts
 * Purpose: credit-reservation.server.ts 单元测试，覆盖预留、消费、释放与幂等。
 *
 * Usage: node --import tsx tests/credit-reservation.server.test.ts
 */

export {};

interface MockBucket {
  id: string;
  shopId: string;
  bucketType: string;
  status: string;
  remainingAmount: number;
  reservedAmount: number;
  consumedAmount: number;
  effectiveAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
}

interface MockReservationLine {
  id: string;
  shopId: string;
  reservationId: string;
  bucketId: string;
  reservedAmount: number;
  consumedAmount: number;
  releasedAmount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MockReservation {
  id: string;
  shopId: string;
  status: string;
  requestedAmount: number;
  reservedAmount: number;
  consumedAmount: number;
  releasedAmount: number;
  batchId: string | null;
  idempotencyKey: string;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockLedger {
  id: string;
  shopId: string;
  bucketId: string;
  reservationId: string | null;
  reservationLineId: string | null;
  type: string;
  deltaAmount: number;
  balanceAfter: number | null;
  reason: string | null;
  metadata: unknown;
  idempotencyKey: string;
  eventAt: Date;
  createdAt: Date;
}

interface MockState {
  buckets: MockBucket[];
  reservations: MockReservation[];
  lines: MockReservationLine[];
  ledgers: MockLedger[];
  nextReservation: number;
  nextLine: number;
  nextLedger: number;
}

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

function makeBucket(overrides: Partial<MockBucket>): MockBucket {
  return {
    id: overrides.id ?? 'bucket-001',
    shopId: overrides.shopId ?? 'shop-001',
    bucketType: overrides.bucketType ?? 'MONTHLY_INCLUDED',
    status: overrides.status ?? 'ACTIVE',
    remainingAmount: overrides.remainingAmount ?? 100,
    reservedAmount: overrides.reservedAmount ?? 0,
    consumedAmount: overrides.consumedAmount ?? 0,
    effectiveAt: overrides.effectiveAt ?? new Date('2026-05-01T00:00:00Z'),
    expiresAt: overrides.expiresAt ?? new Date('2026-06-01T00:00:00Z'),
    createdAt: overrides.createdAt ?? new Date('2026-05-01T00:00:00Z'),
  };
}

function makeState(buckets: MockBucket[]): MockState {
  return {
    buckets,
    reservations: [],
    lines: [],
    ledgers: [],
    nextReservation: 1,
    nextLine: 1,
    nextLedger: 1,
  };
}

function withLines(state: MockState, reservation: MockReservation): MockReservation & { lines: MockReservationLine[] } {
  return {
    ...reservation,
    lines: state.lines.filter((line) => line.reservationId === reservation.id),
  };
}

function createMockPrisma(state: MockState) {
  const tx = {
    $queryRaw: async () => state.buckets
      .filter((bucket) => bucket.status === 'ACTIVE' && bucket.remainingAmount > 0)
      .map((bucket) => ({ id: bucket.id })),
    creditBucket: {
      findMany: async () => state.buckets
        .filter((bucket) => bucket.status === 'ACTIVE' && bucket.remainingAmount > 0)
        .map((bucket) => ({ ...bucket })),
      updateMany: async (args: { where: { id: string; shopId: string; remainingAmount: { gte: number } }; data: { remainingAmount: { decrement: number }; reservedAmount: { increment: number } } }) => {
        const bucket = state.buckets.find((item) => item.id === args.where.id && item.shopId === args.where.shopId);
        if (!bucket || bucket.remainingAmount < args.where.remainingAmount.gte) {
          return { count: 0 };
        }
        bucket.remainingAmount -= args.data.remainingAmount.decrement;
        bucket.reservedAmount += args.data.reservedAmount.increment;
        return { count: 1 };
      },
      findUniqueOrThrow: async (args: { where: { id: string }; select: { remainingAmount: true } }) => {
        const bucket = state.buckets.find((item) => item.id === args.where.id);
        if (!bucket) throw new Error('bucket not found');
        return { remainingAmount: bucket.remainingAmount };
      },
      update: async (args: { where: { id: string }; data: Record<string, { increment?: number; decrement?: number }>; select?: { remainingAmount: true } }) => {
        const bucket = state.buckets.find((item) => item.id === args.where.id);
        if (!bucket) throw new Error('bucket not found');

        const remainingAmount = args.data['remainingAmount'];
        if (remainingAmount?.increment) bucket.remainingAmount += remainingAmount.increment;
        if (remainingAmount?.decrement) bucket.remainingAmount -= remainingAmount.decrement;

        const reservedAmount = args.data['reservedAmount'];
        if (reservedAmount?.increment) bucket.reservedAmount += reservedAmount.increment;
        if (reservedAmount?.decrement) bucket.reservedAmount -= reservedAmount.decrement;

        const consumedAmount = args.data['consumedAmount'];
        if (consumedAmount?.increment) bucket.consumedAmount += consumedAmount.increment;
        if (consumedAmount?.decrement) bucket.consumedAmount -= consumedAmount.decrement;

        return args.select ? { remainingAmount: bucket.remainingAmount } : { ...bucket };
      },
    },
    creditReservation: {
      findUnique: async (args: { where: { shopId_batchId: { shopId: string; batchId: string } }; include: { lines: true } }) => {
        const found = state.reservations.find(
          (reservation) => reservation.shopId === args.where.shopId_batchId.shopId && reservation.batchId === args.where.shopId_batchId.batchId,
        );
        return found ? withLines(state, found) : null;
      },
      findFirst: async (args: { where: { id: string; shopId: string }; include: { lines: true } }) => {
        const found = state.reservations.find(
          (reservation) => reservation.id === args.where.id && reservation.shopId === args.where.shopId,
        );
        return found ? withLines(state, found) : null;
      },
      create: async (args: { data: Omit<MockReservation, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt'> & { resolvedAt?: Date | null } }) => {
        const now = new Date('2026-05-13T00:00:00Z');
        const reservation: MockReservation = {
          id: `reservation-${state.nextReservation++}`,
          ...args.data,
          resolvedAt: args.data.resolvedAt ?? null,
          createdAt: now,
          updatedAt: now,
        };
        state.reservations.push(reservation);
        return { ...reservation };
      },
      update: async (args: { where: { id: string }; data: Partial<MockReservation>; include: { lines: true } }) => {
        const reservation = state.reservations.find((item) => item.id === args.where.id);
        if (!reservation) throw new Error('reservation not found');
        Object.assign(reservation, args.data, { updatedAt: new Date('2026-05-13T00:00:00Z') });
        return withLines(state, reservation);
      },
    },
    creditReservationLine: {
      create: async (args: { data: Omit<MockReservationLine, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const now = new Date('2026-05-13T00:00:00Z');
        const line: MockReservationLine = {
          id: `line-${state.nextLine++}`,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        state.lines.push(line);
        return { ...line };
      },
      update: async (args: { where: { id: string }; data: { consumedAmount?: { increment: number }; releasedAmount?: { increment: number } } }) => {
        const line = state.lines.find((item) => item.id === args.where.id);
        if (!line) throw new Error('line not found');
        if (args.data.consumedAmount) line.consumedAmount += args.data.consumedAmount.increment;
        if (args.data.releasedAmount) line.releasedAmount += args.data.releasedAmount.increment;
        line.updatedAt = new Date('2026-05-13T00:00:00Z');
        return { ...line };
      },
    },
    creditLedger: {
      create: async (args: { data: Omit<MockLedger, 'id' | 'createdAt'> }) => {
        if (state.ledgers.some((ledger) => ledger.idempotencyKey === args.data.idempotencyKey)) {
          throw new Error(`duplicate ledger: ${args.data.idempotencyKey}`);
        }
        const ledger: MockLedger = {
          id: `ledger-${state.nextLedger++}`,
          ...args.data,
          createdAt: new Date('2026-05-13T00:00:00Z'),
        };
        state.ledgers.push(ledger);
        return { ...ledger };
      },
    },
  };

  return {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  };
}

const {
  createReservation,
  consumeReservation,
  releaseReservation,
  InsufficientCreditError,
} = await import('../server/modules/billing/credit/credit-reservation.service.js');

async function run(): Promise<void> {
  console.log('\n=== credit-reservation.server.test.ts ===\n');

  {
    const state = makeState([
      makeBucket({ id: 'b-inc', bucketType: 'MONTHLY_INCLUDED', remainingAmount: 100, expiresAt: new Date('2026-06-01T00:00:00Z') }),
      makeBucket({ id: 'b-wel', bucketType: 'WELCOME', remainingAmount: 50, expiresAt: null }),
    ]);

    const result = await createReservation(
      { shopId: 'shop-001', batchId: 'batch-001', amount: 120, expiresAt: new Date('2026-05-14T00:00:00Z') },
      createMockPrisma(state) as never,
    );

    assertTrue(result.created, '创建 reservation: created=true');
    assertEqual(result.reservation.status, 'ACTIVE', '创建 reservation: status=ACTIVE');
    assertEqual(result.reservation.lines.length, 2, '创建 reservation: 多 bucket 拆 2 条 line');
    assertEqual(state.buckets[0].remainingAmount, 0, '创建 reservation: included remaining 降为 0');
    assertEqual(state.buckets[1].remainingAmount, 30, '创建 reservation: welcome remaining 降为 30');
    assertEqual(state.ledgers.filter((ledger) => ledger.type === 'RESERVE').length, 2, '创建 reservation: 每条 line 写 RESERVE ledger');
    console.log('  ✓ 验收：创建后可用额度减少且多 bucket 拆分正确');
  }

  {
    const state = makeState([makeBucket({ id: 'b-inc', remainingAmount: 100 })]);
    const client = createMockPrisma(state) as never;

    const first = await createReservation({ shopId: 'shop-001', batchId: 'batch-idem', amount: 40 }, client);
    const second = await createReservation({ shopId: 'shop-001', batchId: 'batch-idem', amount: 40 }, client);

    assertTrue(first.created, 'create 幂等: 首次 created=true');
    assertFalse(second.created, 'create 幂等: 第二次 created=false');
    assertEqual(state.reservations.length, 1, 'create 幂等: 只创建一条 reservation');
    assertEqual(state.ledgers.length, 1, 'create 幂等: 只写一次 ledger');
    assertEqual(state.buckets[0].remainingAmount, 60, 'create 幂等: bucket 只扣一次');
    console.log('  ✓ 验收：shopId + batchId 幂等');
  }

  {
    const state = makeState([makeBucket({ id: 'b-inc', remainingAmount: 20 })]);

    await assertThrowsAsync(
      async () => {
        await createReservation(
          { shopId: 'shop-001', batchId: 'batch-low', amount: 50 },
          createMockPrisma(state) as never,
        );
      },
      '额度不足时抛错',
    );

    assertTrue(state.reservations.length === 0, '额度不足: 不创建 reservation');
    assertTrue(state.ledgers.length === 0, '额度不足: 不创建 ledger');
    assertTrue(new InsufficientCreditError(1, 0) instanceof Error, '额度不足错误类型可实例化');
    console.log('  ✓ 验收：额度不足不会创建 reservation');
  }

  {
    const state = makeState([makeBucket({ id: 'b-inc', remainingAmount: 100 })]);
    const client = createMockPrisma(state) as never;
    const created = await createReservation({ shopId: 'shop-001', batchId: 'batch-release', amount: 40 }, client);

    const released = await releaseReservation(
      { shopId: 'shop-001', reservationId: created.reservation.id, reason: 'FAILED_ITEMS' },
      client,
    );
    const repeated = await releaseReservation(
      { shopId: 'shop-001', reservationId: created.reservation.id, reason: 'FAILED_ITEMS' },
      client,
    );

    assertTrue(released.changed, 'release: 首次 changed=true');
    assertFalse(repeated.changed, 'release: 重复 changed=false');
    assertEqual(state.buckets[0].remainingAmount, 100, 'release: 可用额度恢复');
    assertEqual(state.buckets[0].reservedAmount, 0, 'release: reservedAmount 清零');
    assertEqual(state.ledgers.filter((ledger) => ledger.type === 'RELEASE').length, 1, 'release: 不重复写 RELEASE ledger');
    assertEqual(released.reservation.status, 'RELEASED', 'release: 状态为 RELEASED');
    console.log('  ✓ 验收：release 返还额度且重复 release 不重复返还');
  }

  {
    const state = makeState([makeBucket({ id: 'b-inc', remainingAmount: 100 })]);
    const client = createMockPrisma(state) as never;
    const created = await createReservation({ shopId: 'shop-001', batchId: 'batch-consume', amount: 40 }, client);

    const consumed = await consumeReservation(
      { shopId: 'shop-001', reservationId: created.reservation.id },
      client,
    );
    const repeated = await consumeReservation(
      { shopId: 'shop-001', reservationId: created.reservation.id },
      client,
    );

    assertTrue(consumed.changed, 'consume: 首次 changed=true');
    assertFalse(repeated.changed, 'consume: 重复 changed=false');
    assertEqual(state.buckets[0].remainingAmount, 60, 'consume: 可用额度不恢复');
    assertEqual(state.buckets[0].reservedAmount, 0, 'consume: reservedAmount 清零');
    assertEqual(state.buckets[0].consumedAmount, 40, 'consume: consumedAmount 增加');
    assertEqual(state.ledgers.filter((ledger) => ledger.type === 'CONSUME').length, 1, 'consume: 不重复写 CONSUME ledger');
    assertEqual(consumed.reservation.status, 'CONSUMED', 'consume: 状态为 CONSUMED');
    console.log('  ✓ 验收：consume 不恢复额度且重复 consume 不重复记账');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  总计: ${passed + failed}  通过: ${passed}  失败: ${failed}`);

  if (failures.length > 0) {
    console.log('\n  失败详情:');
    for (const failure of failures) {
      console.log(`    - ${failure}`);
    }
    process.exit(1);
  }

  console.log('\n  全部测试通过\n');
}

run().catch((err: unknown) => {
  console.error('测试运行失败:', err);
  process.exit(1);
});
