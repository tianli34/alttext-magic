/**
 * File: server/modules/billing/apply-subscription-change.server.ts
 * Purpose: 订阅变更业务处理服务 —— 根据订阅状态变化完成 included bucket 发放、
 *          首次付费欢迎额度发放、增量扫描开关、Free 降级补发等逻辑。
 *
 * ### 处理场景
 * 1. 升级到月付计划：MONTHLY_INCLUDED + (WELCOME 首次付费) + 开启增量扫描
 * 2. 升级到年付计划：ANNUAL_INCLUDED + (WELCOME 首次付费) + 开启增量扫描
 * 3. 降级回 Free：关闭增量扫描 + 补发当月 FREE_MONTHLY_INCLUDED（如不存在）
 *
 * ### 幂等保证
 * - 所有 bucket 发放通过 grantCreditBucket 的唯一约束 (shopId + bucketType + cycleKey) 实现幂等
 * - 首次付费欢迎额度通过 shop.firstPaidBonusGrantedAt + bucket 唯一约束双重保障
 * - 重复调用仅返回已存在的 bucket，不产生重复数据
 *
 * ### 调用时机
 * 本服务在 subscription.service.ts 或 plan-change.service.ts 完成订阅记录创建/更新之后调用，
 * 负责处理与订阅变更相关的所有额度发放和标记位更新。
 */

import type { PrismaClient, BillingInterval as PrismaBillingInterval } from '@prisma/client';

import { createLogger } from '../../utils/logger.js';
import { grantCreditBucket } from './credit/grant-credit.server.js';
import type { CreditBucketType } from './billing.types.js';
import type { BillingInterval, PlanKey } from './billing.types.js';
import {
  getIncludedCredits,
  getFreeCycleKey,
  getPlanConfig,
  getPaidWelcomeCredits,
} from './plan-config.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'apply-subscription-change' });

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

/** 首次付费欢迎额度 cycleKey（全局唯一，仅发放一次） */
const FIRST_PAID_WELCOME_CYCLE_KEY = 'WELCOME:FIRST_PAID';

/** Free 计划月配额 */
const FREE_MONTHLY_CREDITS = 25;

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 订阅变更处理入参 */
export interface ApplySubscriptionChangeParams {
  /** 店铺内部 ID */
  shopId: string;
  /** 当前生效的 billing_subscription.id */
  subscriptionId: string;
  /** 变更后的计划标识 */
  planKey: PlanKey;
  /** 变更后的计费周期（Prisma 枚举，含 NONE） */
  interval: PrismaBillingInterval;
  /** Shopify 侧订阅 ID（年付计划必传，用于 cycleKey 唯一标识） */
  externalSubscriptionId?: string;
}

/** 订阅变更处理结果 */
export interface ApplySubscriptionChangeResult {
  /** 付费计划 included bucket 发放结果（月付/年付）；Free 降级时为 null */
  included: { created: boolean; bucketId: string } | null;
  /** 首次付费欢迎额度发放结果；非首次付费或 Free 降级时为 null */
  welcome: { created: boolean; bucketId: string } | null;
  /** Free 降级补发月配额结果；付费升级时为 null */
  freeMonthly: { created: boolean; bucketId: string } | null;
  /** 增量扫描最终状态 */
  incrementalScanEnabled: boolean;
}

// ----------------------------------------------------------------------------
// cycleKey 生成
// ----------------------------------------------------------------------------

/**
 * 生成月付计划的 included bucket cycleKey。
 * 格式：`{planKey}:MONTHLY:YYYY-MM`
 * 示例：`STARTER:MONTHLY:2026-05`
 */
function generateMonthlyCycleKey(planKey: PlanKey, date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${planKey}:MONTHLY:${year}-${month}`;
}

/**
 * 生成年付计划的 included bucket cycleKey。
 * 格式：`{planKey}:ANNUAL:{shopifySubscriptionId}`
 * 示例：`GROWTH:ANNUAL:gid://shopify/AppSubscription/1234567`
 */
function generateAnnualCycleKey(planKey: PlanKey, externalSubscriptionId: string): string {
  return `${planKey}:ANNUAL:${externalSubscriptionId}`;
}

// ----------------------------------------------------------------------------
// 核心服务：订阅变更处理
// ----------------------------------------------------------------------------

/**
 * 处理订阅变更后的额度发放和标记位更新。
 *
 * ### 流程
 * 1. 判断 planKey → 分流到升级（付费）或降级（Free）处理
 * 2. 升级付费：
 *    a. 发放 included bucket（MONTHLY_INCLUDED / ANNUAL_INCLUDED）
 *    b. 首次付费 → 发放 WELCOME 欢迎额度 + 更新 shop.firstPaidBonusGrantedAt
 *    c. 开启增量扫描（incrementalScanEnabled = true）
 * 3. 降级 Free：
 *    a. 关闭增量扫描（incrementalScanEnabled = false）
 *    b. 补发当月 FREE_MONTHLY_INCLUDED（如不存在）
 *
 * @param params  变更参数
 * @param client  可选 PrismaClient 实例（默认使用全局单例）
 */
export async function applySubscriptionChange(
  params: ApplySubscriptionChangeParams,
  client?: PrismaClient,
): Promise<ApplySubscriptionChangeResult> {
  const { shopId, subscriptionId, planKey, interval, externalSubscriptionId } = params;

  // ---- 参数校验 ----
  if (!shopId) {
    throw new Error('[apply-subscription-change] shopId 不能为空');
  }
  if (!subscriptionId) {
    throw new Error('[apply-subscription-change] subscriptionId 不能为空');
  }

  // ---- 懒加载全局 Prisma 单例 ----
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../db/prisma.server.js')).default;
  const now = new Date();

  log.info({ shopId, planKey, interval, subscriptionId }, '开始处理订阅变更');

  // ---- 分流 ----
  if (planKey === 'FREE') {
    return applyDowngradeToFree(shopId, subscriptionId, db, now);
  }

  return applyUpgradeToPaid(
    shopId,
    subscriptionId,
    planKey,
    interval as BillingInterval, // 安全：paid plan 的 interval 一定是 MONTHLY 或 ANNUAL
    externalSubscriptionId,
    db,
    now,
  );
}

// ----------------------------------------------------------------------------
// 付费计划升级处理
// ----------------------------------------------------------------------------

/**
 * 处理升级到付费计划的额度发放和标记位更新。
 *
 * 1. 发放 included bucket（根据 interval 区分月付/年付）
 * 2. 首次付费 → 发放 WELCOME 欢迎额度
 * 3. 开启增量扫描
 */
async function applyUpgradeToPaid(
  shopId: string,
  subscriptionId: string,
  planKey: PlanKey,
  interval: BillingInterval,
  externalSubscriptionId: string | undefined,
  db: PrismaClient,
  now: Date,
): Promise<ApplySubscriptionChangeResult> {
  log.info({ shopId, subscriptionId, planKey, interval }, '处理升级到付费计划');

  // ---- 1. 发放 included bucket ----
  const includedBucketType: CreditBucketType = interval === 'ANNUAL' ? 'ANNUAL_INCLUDED' : 'MONTHLY_INCLUDED';
  const includedCredits = getIncludedCredits(planKey, interval);

  let includedCycleKey: string;
  if (interval === 'ANNUAL') {
    // 年付计划必须有 externalSubscriptionId 用于 cycleKey
    if (!externalSubscriptionId) {
      throw new Error('[apply-subscription-change] 年付计划必须提供 externalSubscriptionId');
    }
    includedCycleKey = generateAnnualCycleKey(planKey, externalSubscriptionId);
  } else {
    includedCycleKey = generateMonthlyCycleKey(planKey, now);
  }

  const includedResult = await grantCreditBucket(
    {
      shopId,
      bucketType: includedBucketType,
      amount: includedCredits,
      cycleKey: includedCycleKey,
      effectiveAt: now,
      expiresAt: null,
      billingSubscriptionId: subscriptionId,
      source: 'subscription-change',
      sourceRef: externalSubscriptionId,
      reason: `${planKey} ${interval} 计划额度发放`,
    },
    db,
  );

  // ---- 2. 首次付费欢迎额度 ----
  let welcomeResult: { created: boolean; bucketId: string } | null = null;

  // 通过 shop.firstPaidBonusGrantedAt 判断是否已发放过首次付费欢迎额度
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { firstPaidBonusGrantedAt: true },
  });

  if (!shop?.firstPaidBonusGrantedAt) {
    // 从未发放首次付费欢迎额度
    const welcomeCredits = getPaidWelcomeCredits(planKey);

    const welcomeGrantResult = await grantCreditBucket(
      {
        shopId,
        bucketType: 'WELCOME',
        amount: welcomeCredits,
        cycleKey: FIRST_PAID_WELCOME_CYCLE_KEY,
        effectiveAt: now,
        expiresAt: null,
        billingSubscriptionId: subscriptionId,
        source: 'first-paid-welcome',
        reason: '首次付费欢迎额度',
      },
      db,
    );

    // 仅在实际创建 bucket 时更新标记（幂等安全）
    if (welcomeGrantResult.created) {
      await db.shop.update({
        where: { id: shopId },
        data: { firstPaidBonusGrantedAt: now },
      });
    }

    welcomeResult = {
      created: welcomeGrantResult.created,
      bucketId: welcomeGrantResult.bucket.id,
    };
  } else {
    log.info({ shopId }, '首次付费欢迎额度已发放过，跳过');
  }

  // ---- 3. 开启增量扫描（billingSubscription + shop 双写） ----
  await db.billingSubscription.update({
    where: { id: subscriptionId },
    data: { incrementalScanEnabled: true },
  });

  await db.shop.update({
    where: { id: shopId },
    data: { incrementalScanEnabled: true },
  });

  log.info(
    {
      shopId,
      subscriptionId,
      planKey,
      interval,
      includedCreated: includedResult.created,
      welcomeCreated: welcomeResult?.created ?? false,
      incrementalScanEnabled: true,
    },
    '付费计划升级处理完成',
  );

  return {
    included: {
      created: includedResult.created,
      bucketId: includedResult.bucket.id,
    },
    welcome: welcomeResult,
    freeMonthly: null,
    incrementalScanEnabled: true,
  };
}

// ----------------------------------------------------------------------------
// Free 降级处理
// ----------------------------------------------------------------------------

/**
 * 处理降级到 Free 计划的额度补发和标记位更新。
 *
 * 1. 关闭增量扫描（incrementalScanEnabled = false）
 * 2. 补发当月 FREE_MONTHLY_INCLUDED(25)，如果不存在
 * 3. 保留历史 WELCOME、OVERAGE_PACK（不删除）
 */
async function applyDowngradeToFree(
  shopId: string,
  subscriptionId: string,
  db: PrismaClient,
  now: Date,
): Promise<ApplySubscriptionChangeResult> {
  log.info({ shopId, subscriptionId }, '处理降级到 Free 计划');

  // ---- 1. 关闭增量扫描（billingSubscription + shop 双写） ----
  await db.billingSubscription.update({
    where: { id: subscriptionId },
    data: { incrementalScanEnabled: false },
  });

  await db.shop.update({
    where: { id: shopId },
    data: { incrementalScanEnabled: false },
  });

  // ---- 2. 补发当月 FREE_MONTHLY_INCLUDED（如不存在） ----
  const freeCycleKey = getFreeCycleKey(now);
  // 当月 Free 配额到期时间：下月 1 日 UTC
  const expiresAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  const freeMonthlyResult = await grantCreditBucket(
    {
      shopId,
      bucketType: 'FREE_MONTHLY_INCLUDED',
      amount: FREE_MONTHLY_CREDITS,
      cycleKey: freeCycleKey,
      effectiveAt: now,
      expiresAt,
      billingSubscriptionId: subscriptionId,
      source: 'downgrade-free',
      reason: `${freeCycleKey} Free 月配额补发（降级）`,
    },
    db,
  );

  log.info(
    {
      shopId,
      subscriptionId,
      freeMonthlyCreated: freeMonthlyResult.created,
      incrementalScanEnabled: false,
    },
    'Free 降级处理完成',
  );

  return {
    included: null,
    welcome: null,
    freeMonthly: {
      created: freeMonthlyResult.created,
      bucketId: freeMonthlyResult.bucket.id,
    },
    incrementalScanEnabled: false,
  };
}
