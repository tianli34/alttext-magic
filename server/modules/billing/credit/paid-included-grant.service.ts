/**
 * File: server/modules/billing/credit/paid-included-grant.service.ts
 * Purpose: 付费计划 included 额度桶周期续发服务 —— 修复付费订阅跨周期后配额永不续发的问题。
 *
 * ### 背景（修复前缺陷）
 * 付费 included 桶（MONTHLY_INCLUDED / ANNUAL_INCLUDED）原先仅在订阅变更时一次性发放：
 * 1. 月付：cycleKey = `{planKey}:MONTHLY:YYYY-MM`，跨月进入新周期后无人发放新桶，配额止于首月；
 * 2. 年付：cycleKey = `{planKey}:ANNUAL:{shopifySubscriptionId}`，Shopify 年度续订不更换 GID、
 *    planCode/status 也不变化（changed=false），订阅同步与实时路径均不触发发放，第二年无桶。
 *
 * ### 方案
 * 挂载到既有 quota-grant 月度调度（与 Free 月配额同一触发点）：
 * 1. 月付订阅：按自然月 cycleKey `{planKey}:MONTHLY:YYYY-MM` 幂等补发当月配额，
 *    桶有效期 = 当月月初 → 次月 1 日 00:00 UTC（与 FREE_MONTHLY 对齐，避免跨月无限累积）；
 * 2. 年付订阅：以订阅周期末 currentPeriodEnd 为锚做"周期内覆盖检查"——
 *    [periodEnd - 1 年, periodEnd) 窗口内已有 ANNUAL_INCLUDED 桶（ACTIVE/EXHAUSTED）则跳过，
 *    否则说明 Shopify 已续订滚动周期，以 `{planKey}:ANNUAL:{gid}:{periodEnd 年份}` 为 cycleKey
 *    幂等补发全年配额（续订年 GID 不变，故 cycleKey 追加年份后缀区分首次发放的无后缀格式），
 *    桶有效期至 periodEnd（对齐订阅周年）。
 *
 * ### 幂等保证
 * - 发放全部通过 grantCreditBucket 的唯一约束 (shopId + bucketType + cycleKey) 实现；
 * - 年付覆盖检查按 effectiveAt 周期窗口判断（与 cycleKey 格式解耦），
 *   兼容 apply-subscription-change 首次发放的无年份后缀格式，重复执行自然跳过。
 *
 * ### 调用时机
 * - worker/processors/quota-grant.processor.ts（BullMQ repeatable 月度调度）
 */

import type { PrismaClient } from '@prisma/client';

import { createLogger } from '../../../utils/logger.js';
import { grantCreditBucket } from './grant-credit.server.js';
import {
  generateAnnualRenewalCycleKey,
  generateMonthlyIncludedCycleKey,
} from '../included-cycle-key.js';
import { getIncludedCredits } from '../plan-config.js';
import { PLAN_KEYS } from '../billing.types.js';
import type { PlanKey } from '../billing.types.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'paid-included-grant' });

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 付费 included 额度续发结果统计 */
export interface PaidIncludedGrantResult {
  /** 扫描到的付费 ACTIVE 订阅总数 */
  totalPaidSubscriptions: number;
  /** 本次实际新发放的订阅数 */
  grantedCount: number;
  /** 已覆盖/不满足条件（跳过）的订阅数 */
  skippedCount: number;
  /** 发放失败的订阅数 */
  failedCount: number;
  /** 失败详情 */
  failures: Array<{ shopId: string; subscriptionId: string; error: string }>;
}

// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------

/** 校验 planCode 是否为合法的付费 PlanKey */
function isPaidPlanKey(planCode: string): planCode is PlanKey {
  return planCode !== 'FREE' && (PLAN_KEYS as readonly string[]).includes(planCode);
}

/** 计算年付订阅当前周期的覆盖检查窗口：[periodEnd - 1 年, periodEnd) */
function computeAnnualCoverageWindow(periodEnd: Date): { windowStart: Date; windowEnd: Date } {
  return {
    windowStart: new Date(Date.UTC(periodEnd.getUTCFullYear() - 1, periodEnd.getUTCMonth(), periodEnd.getUTCDate())),
    windowEnd: periodEnd,
  };
}

// ----------------------------------------------------------------------------
// 核心实现
// ----------------------------------------------------------------------------

/**
 * 执行一次付费计划 included 额度批量续发。
 *
 * ### 流程
 * 1. 查询所有 ACTIVE 付费订阅（planCode != FREE，店铺未卸载）
 * 2. 月付：按自然月 cycleKey 幂等补发当月配额（桶有效期至次月 1 日）
 * 3. 年付：按订阅周期窗口覆盖检查，新周期无桶则幂等补发全年配额（桶有效期至周期末）
 * 4. 单店失败不中断批次，返回统计
 *
 * @param targetMonth 可选目标月份（YYYY-MM，仅作用于月付补发），为空则使用当前 UTC 月份
 * @param client 可选 PrismaClient 实例（默认使用全局单例，方便测试注入）
 */
export async function grantPaidIncludedToAllSubscriptions(
  targetMonth?: string,
  client?: PrismaClient,
): Promise<PaidIncludedGrantResult> {
  // ---- 懒加载全局 Prisma 单例 ----
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../../db/prisma.server.js')).default;

  if (targetMonth && !/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error(
      `[paid-included-grant] targetMonth 格式无效: ${targetMonth}，期望 YYYY-MM`,
    );
  }

  const now = new Date();
  // 月付锚点：targetMonth 的月初，否则当前时间
  const monthlyAnchor = targetMonth
    ? new Date(`${targetMonth}-01T00:00:00.000Z`)
    : now;

  log.info({ targetMonth }, '开始付费 included 额度批量续发');

  // ---- 查询所有付费 ACTIVE 订阅（排除已卸载店铺） ----
  const paidSubscriptions = await db.billingSubscription.findMany({
    where: {
      status: 'ACTIVE',
      planCode: { not: 'FREE' },
      shop: { uninstalledAt: null },
    },
    select: {
      id: true,
      shopId: true,
      planCode: true,
      billingInterval: true,
      externalSubscriptionId: true,
      currentPeriodEnd: true,
    },
  });

  log.info({ paidSubscriptionCount: paidSubscriptions.length }, '扫描到付费 ACTIVE 订阅');

  const emptyResult: PaidIncludedGrantResult = {
    totalPaidSubscriptions: 0,
    grantedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    failures: [],
  };
  if (paidSubscriptions.length === 0) return emptyResult;

  // ---- 逐订阅处理 ----
  let grantedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const failures: PaidIncludedGrantResult['failures'] = [];

  for (const subscription of paidSubscriptions) {
    const { id: subscriptionId, shopId } = subscription;

    try {
      // ---- 前置校验：planCode 合法性 ----
      if (!isPaidPlanKey(subscription.planCode)) {
        skippedCount++;
        log.warn(
          { shopId, subscriptionId, planCode: subscription.planCode },
          '付费 included 续发：planCode 非法，跳过',
        );
        continue;
      }
      const planKey: PlanKey = subscription.planCode;

      // ---- 分支：月付 / 年付 ----
      if (subscription.billingInterval === 'ANNUAL') {
        const granted = await grantAnnualIfNeeded(subscription, planKey, db, now);
        if (granted) {
          grantedCount++;
        } else {
          skippedCount++;
        }
      } else if (subscription.billingInterval === 'MONTHLY') {
        const granted = await grantMonthlyIfNeeded(subscription, planKey, monthlyAnchor, db);
        if (granted) {
          grantedCount++;
        } else {
          skippedCount++;
        }
      } else {
        // NONE 等异常周期：数据异常，跳过等待订阅同步修正
        skippedCount++;
        log.warn(
          { shopId, subscriptionId, billingInterval: subscription.billingInterval },
          '付费 included 续发：计费周期异常，跳过',
        );
      }
    } catch (error: unknown) {
      failedCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      failures.push({ shopId, subscriptionId, error: errorMessage });
      log.error(
        { shopId, subscriptionId, err: error },
        '付费 included 额度续发失败',
      );
      // 不中断循环，继续处理其他订阅
    }
  }

  const result: PaidIncludedGrantResult = {
    totalPaidSubscriptions: paidSubscriptions.length,
    grantedCount,
    skippedCount,
    failedCount,
    failures,
  };

  log.info(result, '付费 included 额度批量续发完成');

  return result;
}

/**
 * 月付订阅的当月 included 额度补发。
 *
 * @returns 是否实际新发放（当月桶已存在时返回 false）
 */
async function grantMonthlyIfNeeded(
  subscription: {
    id: string;
    shopId: string;
    externalSubscriptionId: string | null;
  },
  planKey: PlanKey,
  monthlyAnchor: Date,
  db: PrismaClient,
): Promise<boolean> {
  const cycleKey = generateMonthlyIncludedCycleKey(planKey, monthlyAnchor);

  // 覆盖检查：当月桶已存在则跳过（唯一约束兜底，此处预查减少无效调用）
  const existing = await db.creditBucket.findFirst({
    where: { shopId: subscription.shopId, bucketType: 'MONTHLY_INCLUDED', cycleKey },
    select: { id: true },
  });
  if (existing) {
    log.info(
      { shopId: subscription.shopId, subscriptionId: subscription.id, cycleKey },
      '月付 included 当月桶已存在（幂等跳过）',
    );
    return false;
  }

  // 桶有效期：当月月初 → 次月 1 日 00:00 UTC（与 FREE_MONTHLY 生命周期对齐）
  const effectiveAt = new Date(
    Date.UTC(monthlyAnchor.getUTCFullYear(), monthlyAnchor.getUTCMonth(), 1),
  );
  const expiresAt = new Date(
    Date.UTC(monthlyAnchor.getUTCFullYear(), monthlyAnchor.getUTCMonth() + 1, 1),
  );

  const result = await grantCreditBucket(
    {
      shopId: subscription.shopId,
      bucketType: 'MONTHLY_INCLUDED',
      amount: getIncludedCredits(planKey, 'MONTHLY'),
      cycleKey,
      effectiveAt,
      expiresAt,
      billingSubscriptionId: subscription.id,
      source: 'paid-monthly-grant',
      sourceRef: subscription.externalSubscriptionId ?? undefined,
      reason: `${planKey} MONTHLY 计划 ${cycleKey} 月度额度续发`,
    },
    db,
  );

  if (result.created) {
    log.info(
      { shopId: subscription.shopId, subscriptionId: subscription.id, cycleKey },
      '月付 included 月度额度续发成功',
    );
    return true;
  }
  return false;
}

/**
 * 年付订阅的当期 included 额度补发（按订阅周期窗口覆盖检查）。
 *
 * @returns 是否实际新发放（当前周期已有桶/周期数据缺失时返回 false）
 */
async function grantAnnualIfNeeded(
  subscription: {
    id: string;
    shopId: string;
    externalSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
  },
  planKey: PlanKey,
  db: PrismaClient,
  now: Date,
): Promise<boolean> {
  const { shopId, id: subscriptionId, currentPeriodEnd } = subscription;

  // 周期数据缺失或已过期（未同步到最新续订）→ 跳过，等待订阅同步后再补
  if (!currentPeriodEnd || currentPeriodEnd <= now) {
    log.info(
      { shopId, subscriptionId, currentPeriodEnd },
      '年付 included 续发：currentPeriodEnd 缺失或已过期，跳过（等待订阅同步）',
    );
    return false;
  }

  // ---- 覆盖检查：当前周期窗口内已有年付桶则跳过 ----
  const { windowStart, windowEnd } = computeAnnualCoverageWindow(currentPeriodEnd);
  const covered = await db.creditBucket.findFirst({
    where: {
      shopId,
      bucketType: 'ANNUAL_INCLUDED',
      status: { in: ['ACTIVE', 'EXHAUSTED'] },
      effectiveAt: { gte: windowStart, lt: windowEnd },
    },
    select: { id: true, cycleKey: true },
  });
  if (covered) {
    log.info(
      { shopId, subscriptionId, coveredCycleKey: covered.cycleKey, windowStart, windowEnd },
      '年付 included 当前周期已覆盖（幂等跳过）',
    );
    return false;
  }

  // ---- 数据异常：年付订阅必须有 externalSubscriptionId 参与 cycleKey ----
  if (!subscription.externalSubscriptionId) {
    throw new Error(
      `[paid-included-grant] 年付订阅缺少 externalSubscriptionId: subscriptionId=${subscriptionId}`,
    );
  }

  // 续订周期 GID 不变，cycleKey 追加 periodEnd 年份后缀区分首次发放
  const cycleKey = generateAnnualRenewalCycleKey(
    planKey,
    subscription.externalSubscriptionId,
    currentPeriodEnd.getUTCFullYear(),
  );

  const result = await grantCreditBucket(
    {
      shopId,
      bucketType: 'ANNUAL_INCLUDED',
      amount: getIncludedCredits(planKey, 'ANNUAL'),
      cycleKey,
      effectiveAt: now,
      expiresAt: currentPeriodEnd,
      billingSubscriptionId: subscriptionId,
      source: 'paid-annual-grant',
      sourceRef: subscription.externalSubscriptionId,
      reason: `${planKey} ANNUAL 计划 ${currentPeriodEnd.getUTCFullYear()} 年度额度续发`,
    },
    db,
  );

  if (result.created) {
    log.info(
      { shopId, subscriptionId, cycleKey, expiresAt: currentPeriodEnd },
      '年付 included 年度额度续发成功',
    );
    return true;
  }
  return false;
}
