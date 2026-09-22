/**
 * File: tests/unit/billing/consumption-order.test.ts
 * Purpose: 额度消费顺序排序（server/modules/billing/credit/consumption-order.ts）单元测试。
 *          消费顺序规格（§4.9.4）：
 *          1. Included family（最早到期优先）→ 2. WELCOME → 3. OVERAGE_PACK
 *          Included family 内部：expiresAt ASC（null 最后）→ effectiveAt ASC → createdAt ASC
 */
import { describe, expect, it } from 'vitest';

import {
  getConsumptionPriority,
  isIncludedFamily,
  sortBucketsByConsumptionOrder,
  type SpendableBucket,
} from '../../../server/modules/billing/credit/consumption-order';
import type { CreditBucketType } from '../../../server/modules/billing/billing.types';

// ============================================================================
// 测试辅助
// ============================================================================

/** 构造可消费桶，仅覆盖排序关心的字段 */
function makeBucket(overrides: Partial<SpendableBucket> & { bucketType: CreditBucketType }): SpendableBucket {
  return {
    remainingAmount: 100,
    expiresAt: null,
    effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ============================================================================
// 类型归属与优先级权重
// ============================================================================

describe('isIncludedFamily', () => {
  it('三种 included 桶均属于 included family', () => {
    expect(isIncludedFamily('FREE_MONTHLY_INCLUDED')).toBe(true);
    expect(isIncludedFamily('MONTHLY_INCLUDED')).toBe(true);
    expect(isIncludedFamily('ANNUAL_INCLUDED')).toBe(true);
  });

  it('WELCOME 与 OVERAGE_PACK 不属于 included family', () => {
    expect(isIncludedFamily('WELCOME')).toBe(false);
    expect(isIncludedFamily('OVERAGE_PACK')).toBe(false);
  });
});

describe('getConsumptionPriority', () => {
  it('included family 共享权重 10，WELCOME 为 20，OVERAGE_PACK 为 30', () => {
    expect(getConsumptionPriority('FREE_MONTHLY_INCLUDED')).toBe(10);
    expect(getConsumptionPriority('MONTHLY_INCLUDED')).toBe(10);
    expect(getConsumptionPriority('ANNUAL_INCLUDED')).toBe(10);
    expect(getConsumptionPriority('WELCOME')).toBe(20);
    expect(getConsumptionPriority('OVERAGE_PACK')).toBe(30);
  });
});

// ============================================================================
// 消费顺序排序
// ============================================================================

describe('sortBucketsByConsumptionOrder', () => {
  it('跨 family 排序：included → WELCOME → OVERAGE_PACK', () => {
    const overage = makeBucket({ bucketType: 'OVERAGE_PACK' });
    const welcome = makeBucket({ bucketType: 'WELCOME' });
    const included = makeBucket({ bucketType: 'MONTHLY_INCLUDED' });

    const sorted = sortBucketsByConsumptionOrder([overage, welcome, included]);

    expect(sorted.map((b) => b.bucketType)).toEqual([
      'MONTHLY_INCLUDED',
      'WELCOME',
      'OVERAGE_PACK',
    ]);
  });

  it('included family 内部按 expiresAt 升序，最早到期优先消费', () => {
    const later = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const sooner = makeBucket({
      bucketType: 'FREE_MONTHLY_INCLUDED',
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const sorted = sortBucketsByConsumptionOrder([later, sooner]);

    expect(sorted[0]).toBe(sooner);
    expect(sorted[1]).toBe(later);
  });

  it('expiresAt 为 null 视为无穷大，排在最后', () => {
    const noExpiry = makeBucket({ bucketType: 'ANNUAL_INCLUDED', expiresAt: null });
    const withExpiry = makeBucket({
      bucketType: 'ANNUAL_INCLUDED',
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });

    const sorted = sortBucketsByConsumptionOrder([noExpiry, withExpiry]);

    expect(sorted[0]).toBe(withExpiry);
    expect(sorted[1]).toBe(noExpiry);
  });

  it('expiresAt 相同时按 effectiveAt 升序', () => {
    const expiresAt = new Date('2026-06-01T00:00:00.000Z');
    const laterEffective = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt,
      effectiveAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const soonerEffective = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt,
      effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const sorted = sortBucketsByConsumptionOrder([laterEffective, soonerEffective]);

    expect(sorted[0]).toBe(soonerEffective);
    expect(sorted[1]).toBe(laterEffective);
  });

  it('expiresAt 与 effectiveAt 均相同时按 createdAt 升序', () => {
    const expiresAt = new Date('2026-06-01T00:00:00.000Z');
    const effectiveAt = new Date('2026-01-01T00:00:00.000Z');
    const older = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt,
      effectiveAt,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt,
      effectiveAt,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const sorted = sortBucketsByConsumptionOrder([newer, older]);

    expect(sorted[0]).toBe(older);
    expect(sorted[1]).toBe(newer);
  });

  it('included family 三种类型混合时统一按到期时间排序（不按类型细分）', () => {
    const annual = makeBucket({
      bucketType: 'ANNUAL_INCLUDED',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    const freeMonthly = makeBucket({
      bucketType: 'FREE_MONTHLY_INCLUDED',
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const monthly = makeBucket({
      bucketType: 'MONTHLY_INCLUDED',
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const sorted = sortBucketsByConsumptionOrder([annual, monthly, freeMonthly]);

    expect(sorted.map((b) => b.bucketType)).toEqual([
      'FREE_MONTHLY_INCLUDED',
      'MONTHLY_INCLUDED',
      'ANNUAL_INCLUDED',
    ]);
  });

  it('支持 keyExtractor 从包装对象中提取桶数据', () => {
    interface Wrapped {
      id: string;
      bucket: SpendableBucket;
    }
    const wrapped: Wrapped[] = [
      { id: 'w-overage', bucket: makeBucket({ bucketType: 'OVERAGE_PACK' }) },
      { id: 'w-included', bucket: makeBucket({ bucketType: 'FREE_MONTHLY_INCLUDED' }) },
    ];

    const sorted = sortBucketsByConsumptionOrder(wrapped, (item) => item.bucket);

    expect(sorted.map((item) => item.id)).toEqual(['w-included', 'w-overage']);
  });

  it('不修改入参数组（纯函数语义）', () => {
    const a = makeBucket({ bucketType: 'OVERAGE_PACK' });
    const b = makeBucket({ bucketType: 'WELCOME' });
    const input = [a, b];

    const sorted = sortBucketsByConsumptionOrder(input);

    expect(input[0]).toBe(a);
    expect(input[1]).toBe(b);
    expect(sorted).not.toBe(input);
  });

  it('空数组与单元素数组原样返回', () => {
    expect(sortBucketsByConsumptionOrder([])).toEqual([]);
    const single = makeBucket({ bucketType: 'WELCOME' });
    expect(sortBucketsByConsumptionOrder([single])).toEqual([single]);
  });
});
