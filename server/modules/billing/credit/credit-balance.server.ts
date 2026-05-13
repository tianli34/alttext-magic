/**
 * File: server/modules/billing/credit/credit-balance.server.ts
 * Purpose: 统一的可用额度计算服务 —— 为 preflight、summary、reservation 提供基础能力。
 *
 * ### 提供能力
 * - getCreditBalance(shopId)  → 分组余额概览
 * - getSpendableBuckets(shopId) → 按消费顺序排列的可消费桶列表
 * - planCreditAllocation(shopId, amount) → 额度分配规划
 *
 * ### 消费顺序（§4.9.4）
 * 1. Included family（按 expiresAt ASC 消耗）
 * 2. WELCOME
 * 3. OVERAGE_PACK
 */

import type { PrismaClient, CreditBucket } from '@prisma/client';

import { createLogger } from '../../../utils/logger.js';
import type { CreditBucketType } from '../billing.types';
import {
  isIncludedFamily,
  sortBucketsByConsumptionOrder,
  type SpendableBucket,
} from './consumption-order.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger({ module: 'credit-balance' });

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** included 周期类型标识 */
export type IncludedPeriodType = 'MONTHLY' | 'ANNUAL';

/** 单个可消费桶的摘要信息 */
export interface SpendableBucketSummary {
  /** 桶 ID */
  bucketId: string;
  /** 桶类型 */
  bucketType: CreditBucketType;
  /** 剩余额度 */
  remainingAmount: number;
  /** 过期时间 */
  expiresAt: Date | null;
}

/** getCreditBalance 返回结构 */
export interface CreditBalanceResult {
  /** included family 剩余总额 */
  includedRemaining: number;
  /** included 周期类型（FREE 视为 MONTHLY） */
  includedPeriodType: IncludedPeriodType;
  /** 欢迎额度剩余 */
  welcomeRemaining: number;
  /** 超额包剩余 */
  overagePackRemaining: number;
  /** 总剩余 */
  totalRemaining: number;
  /** 按消费顺序排列的可消费桶 */
  buckets: SpendableBucketSummary[];
}

/** 单个分配条目 */
export interface AllocationEntry {
  /** 桶 ID */
  bucketId: string;
  /** 桶类型 */
  bucketType: CreditBucketType;
  /** 从该桶分配的额度数 */
  amount: number;
}

/** planCreditAllocation 返回结构 */
export interface CreditAllocationPlan {
  /** 额度是否充足 */
  enough: boolean;
  /** 请求的总额 */
  requested: number;
  /** 实际可分配的总额（enough 时等于 requested） */
  allocatable: number;
  /** 分配明细 */
  allocation: AllocationEntry[];
}

// ---------------------------------------------------------------------------
// includedPeriodType 推断
// ---------------------------------------------------------------------------

/**
 * 从桶列表中推断 includedPeriodType。
 * 规则：
 * - 含 ANNUAL_INCLUDED → "ANNUAL"
 * - 含 MONTHLY_INCLUDED 或 FREE_MONTHLY_INCLUDED → "MONTHLY"
 * - 无 included 桶 → "MONTHLY"（默认值）
 */
function inferIncludedPeriodType(
  buckets: readonly Pick<SpendableBucketSummary, 'bucketType'>[],
): IncludedPeriodType {
  for (const b of buckets) {
    if (b.bucketType === 'ANNUAL_INCLUDED') return 'ANNUAL';
  }
  return 'MONTHLY';
}

// ---------------------------------------------------------------------------
// 内部辅助：带原始数据的排序容器
// ---------------------------------------------------------------------------

/** 排序辅助：将原始 Prisma 结果与排序字段绑定 */
interface BucketWithSortKey {
  raw: CreditBucket;
  sortKey: SpendableBucket;
}

// ---------------------------------------------------------------------------
// getSpendableBuckets — 按消费顺序返回可消费桶
// ---------------------------------------------------------------------------

/**
 * 获取店铺的所有可消费额度桶，按 §4.9.4 消费顺序排列。
 *
 * 查询条件：
 * - shopId 匹配
 * - status = ACTIVE
 * - remainingAmount > 0
 * - effectiveAt <= now
 * - expiresAt IS NULL OR expiresAt > now
 *
 * @param shopId  店铺 ID
 * @param client 可选 PrismaClient 实例（默认使用全局单例，方便测试注入）
 */
export async function getSpendableBuckets(
  shopId: string,
  client?: PrismaClient,
): Promise<SpendableBucketSummary[]> {
  if (!shopId) {
    throw new Error('[credit-balance] shopId 不能为空');
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../../db/prisma.server.js')).default;

  const now = new Date();

  const rawBuckets = await db.creditBucket.findMany({
    where: {
      shopId,
      status: 'ACTIVE',
      remainingAmount: { gt: 0 },
      effectiveAt: { lte: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
  });

  // 构造排序容器
  const withSortKeys: BucketWithSortKey[] = rawBuckets.map((raw) => ({
    raw,
    sortKey: {
      bucketType: raw.bucketType as CreditBucketType,
      remainingAmount: raw.remainingAmount,
      expiresAt: raw.expiresAt,
      effectiveAt: raw.effectiveAt,
      createdAt: raw.createdAt,
    },
  }));

  // 按 §4.9.4 消费顺序排序
  const sorted = sortBucketsByConsumptionOrder(withSortKeys, (item) => item.sortKey);

  // 映射为摘要
  const summaries: SpendableBucketSummary[] = sorted.map((item) => ({
    bucketId: item.raw.id,
    bucketType: item.raw.bucketType as CreditBucketType,
    remainingAmount: item.raw.remainingAmount,
    expiresAt: item.raw.expiresAt,
  }));

  log.debug({ shopId, bucketCount: summaries.length }, '查询可消费桶完成');

  return summaries;
}

// ---------------------------------------------------------------------------
// getCreditBalance — 分组余额概览
// ---------------------------------------------------------------------------

/**
 * 获取店铺的分组额度余额。
 *
 * 返回结构：
 * - includedRemaining: included family 总剩余
 * - includedPeriodType: MONTHLY | ANNUAL
 * - welcomeRemaining: 欢迎额度总剩余
 * - overagePackRemaining: 超额包总剩余
 * - totalRemaining: 总剩余
 * - buckets: 按消费顺序排列的可消费桶
 *
 * @param shopId  店铺 ID
 * @param client 可选 PrismaClient 实例
 */
export async function getCreditBalance(
  shopId: string,
  client?: PrismaClient,
): Promise<CreditBalanceResult> {
  const buckets = await getSpendableBuckets(shopId, client);

  let includedRemaining = 0;
  let welcomeRemaining = 0;
  let overagePackRemaining = 0;

  for (const b of buckets) {
    if (isIncludedFamily(b.bucketType)) {
      includedRemaining += b.remainingAmount;
    } else if (b.bucketType === 'WELCOME') {
      welcomeRemaining += b.remainingAmount;
    } else if (b.bucketType === 'OVERAGE_PACK') {
      overagePackRemaining += b.remainingAmount;
    }
  }

  const totalRemaining = includedRemaining + welcomeRemaining + overagePackRemaining;
  const includedPeriodType = inferIncludedPeriodType(buckets);

  log.debug(
    { shopId, totalRemaining, includedRemaining, welcomeRemaining, overagePackRemaining },
    '余额计算完成',
  );

  return {
    includedRemaining,
    includedPeriodType,
    welcomeRemaining,
    overagePackRemaining,
    totalRemaining,
    buckets,
  };
}

// ---------------------------------------------------------------------------
// planCreditAllocation — 额度分配规划
// ---------------------------------------------------------------------------

/**
 * 规划指定额度的消费分配方案。
 *
 * 按 §4.9.4 消费顺序逐桶分配：
 * 1. Included family（按 expiresAt ASC）
 * 2. WELCOME
 * 3. OVERAGE_PACK
 *
 * 如果 totalRemaining >= amount，则 enough = true，且分配总额等于请求额度。
 * 如果 totalRemaining < amount，则 enough = false，分配所有可分配额度。
 *
 * @param shopId  店铺 ID
 * @param amount  需要分配的额度数量（必须 > 0）
 * @param client 可选 PrismaClient 实例
 */
export async function planCreditAllocation(
  shopId: string,
  amount: number,
  client?: PrismaClient,
): Promise<CreditAllocationPlan> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`[credit-balance] amount 必须为正整数，当前: ${amount}`);
  }

  const buckets = await getSpendableBuckets(shopId, client);

  let remaining = amount;
  const allocation: AllocationEntry[] = [];

  for (const b of buckets) {
    if (remaining <= 0) break;

    const take = Math.min(b.remainingAmount, remaining);
    if (take > 0) {
      allocation.push({
        bucketId: b.bucketId,
        bucketType: b.bucketType,
        amount: take,
      });
      remaining -= take;
    }
  }

  const enough = remaining === 0;
  const allocatable = amount - remaining;

  log.debug(
    { shopId, requested: amount, allocatable, enough, bucketCount: allocation.length },
    '额度分配规划完成',
  );

  return {
    enough,
    requested: amount,
    allocatable,
    allocation,
  };
}
