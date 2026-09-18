/**
 * File: server/modules/billing/apply-subscription-change.server.ts
 * Purpose: 订阅变更业务处理服务 —— 根据订阅状态变化完成 included bucket 发放、
 *          旧计划 included 桶作废、首次付费欢迎额度发放、增量扫描开关、Free 降级补发等逻辑。
 *
 * ### 处理场景
 * 1. 升级到月付计划：MONTHLY_INCLUDED + 作废旧 included 桶 + (WELCOME 首次付费) + 开启增量扫描
 * 2. 升级到年付计划：ANNUAL_INCLUDED + 作废旧 included 桶 + (WELCOME 首次付费) + 开启增量扫描
 * 3. 降级回 Free：关闭增量扫描 + 作废旧付费 included 桶 + 补发当月 FREE_MONTHLY_INCLUDED（如不存在）
 *
 * ### 幂等保证
 * - 所有 bucket 发放通过 grantCreditBucket 的唯一约束 (shopId + bucketType + cycleKey) 实现幂等
 * - 首次付费欢迎额度通过 shop.firstPaidBonusGrantedAt + bucket 唯一约束双重保障
 * - 旧桶作废仅命中 status=ACTIVE 的 included 桶，二次执行自然无匹配
 * - 重复调用仅返回已存在的 bucket，不产生重复数据
 *
 * ### 调用时机
 * - 实时：syncSubscriptionFromShopify 返回 changed=true 后，由 callback / webhook 调用
 *   applySubscriptionChangeFromSync（本文件导出）立即发放。
 * - 兜底：billing-sync.job 每 6 小时批量同步并调用 applySubscriptionChange。
 */

import type { PrismaClient, BillingInterval as PrismaBillingInterval } from '@prisma/client';

import { createLogger } from '../../utils/logger.js';
import { grantCreditBucket } from './credit/grant-credit.server.js';
import type { SyncSubscriptionResult } from './subscription.service.js';
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
// 旧 included 桶作废
// ----------------------------------------------------------------------------

/** included family 全量类型 */
const INCLUDED_FAMILY_BUCKET_TYPES: readonly CreditBucketType[] = [
  'FREE_MONTHLY_INCLUDED',
  'MONTHLY_INCLUDED',
  'ANNUAL_INCLUDED',
];

/** 作废操作入参 */
interface ExpireIncludedBucketsParams {
  shopId: string;
  /** 可作废的候选类型集合 */
  candidateTypes: readonly CreditBucketType[];
  /** 本次发放、需要保留的桶；无新桶时为 null */
  keep: { bucketType: CreditBucketType; cycleKey: string } | null;
  /** 写入 EXPIRE ledger 的原因 */
  reason: string;
}

/**
 * 将候选 included 类型下仍 ACTIVE 的旧桶置为 EXPIRED，并按剩余量写 EXPIRE ledger。
 *
 * 幂等：仅命中 status=ACTIVE 的桶，二次执行时旧桶已转 EXPIRED 不再匹配；
 * ledger idempotencyKey 由 bucketId 唯一确定，并发重复写入会被唯一约束拒绝。
 *
 * @returns 被作废的 bucket ID 列表
 */
async function expireIncludedBuckets(
  params: ExpireIncludedBucketsParams,
  db: PrismaClient,
  now: Date,
): Promise<string[]> {
  const { shopId, candidateTypes, keep, reason } = params;

  const staleBuckets = await db.creditBucket.findMany({
    where: {
      shopId,
      status: 'ACTIVE',
      bucketType: { in: [...candidateTypes] },
      ...(keep
        ? { NOT: [{ bucketType: keep.bucketType, cycleKey: keep.cycleKey }] }
        : {}),
    },
    select: { id: true, remainingAmount: true },
  });

  const expiredIds: string[] = [];

  for (const bucket of staleBuckets) {
    await db.$transaction(async (tx) => {
      const { count } = await tx.creditBucket.updateMany({
        where: { id: bucket.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED', expiresAt: now },
      });
      if (count === 0) return;

      if (bucket.remainingAmount > 0) {
        await tx.creditLedger.create({
          data: {
            shopId,
            bucketId: bucket.id,
            type: 'EXPIRE',
            deltaAmount: -bucket.remainingAmount,
            balanceAfter: 0,
            reason,
            idempotencyKey: `${shopId}:EXPIRE:${bucket.id}`,
            eventAt: now,
          },
        });
      }
    });
    expiredIds.push(bucket.id);
  }

  if (expiredIds.length > 0) {
    log.info({ shopId, expiredBucketIds: expiredIds }, '旧 included 额度桶作废完成');
  }

  return expiredIds;
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

  // ---- 1b. 作废旧计划遗留的 included 桶（保留本次发放的桶） ----
  await expireIncludedBuckets(
    {
      shopId,
      candidateTypes: INCLUDED_FAMILY_BUCKET_TYPES,
      keep: { bucketType: includedBucketType, cycleKey: includedCycleKey },
      reason: `${planKey} ${interval} 计划切换，作废旧 included 额度`,
    },
    db,
    now,
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
 * 3. 作废旧付费计划的 included 桶（MONTHLY / ANNUAL_INCLUDED）
 * 4. 保留历史 WELCOME、OVERAGE_PACK（不删除）
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

  // ---- 3. 作废旧付费计划的 included 桶 ----
  await expireIncludedBuckets(
    {
      shopId,
      candidateTypes: ['MONTHLY_INCLUDED', 'ANNUAL_INCLUDED'],
      keep: null,
      reason: '降级到 Free，作废旧付费 included 额度',
    },
    db,
    now,
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

// ----------------------------------------------------------------------------
// 实时入口：基于订阅同步结果触发变更处理
// ----------------------------------------------------------------------------

/**
 * 根据 syncSubscriptionFromShopify 的结果即时执行订阅变更处理（发放额度、作废旧桶）。
 *
 * 仅在 changed=true 且最终状态为 ACTIVE 时执行；异常只记录日志并返回 false，
 * 不中断调用方流程（callback 重定向 / webhook 确认），由 billing-sync 定时任务兜底重试。
 *
 * @param syncResult  订阅同步结果（需含 shopId / subscriptionId / planCode / status）
 * @param client      可选 PrismaClient 实例
 * @returns 是否实际执行了 applySubscriptionChange
 */
export async function applySubscriptionChangeFromSync(
  syncResult: SyncSubscriptionResult,
  client?: PrismaClient,
): Promise<boolean> {
  if (!syncResult.changed) {
    return false;
  }

  if (syncResult.status !== 'ACTIVE') {
    log.info(
      { shopId: syncResult.shopId, status: syncResult.status },
      '订阅非 ACTIVE，跳过实时额度发放',
    );
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../db/prisma.server.js')).default;

  try {
    const subscription = await db.billingSubscription.findUnique({
      where: { id: syncResult.subscriptionId },
      select: { billingInterval: true, externalSubscriptionId: true },
    });

    if (!subscription) {
      log.warn(
        { shopId: syncResult.shopId, subscriptionId: syncResult.subscriptionId },
        'applySubscriptionChangeFromSync: 未找到订阅记录，跳过',
      );
      return false;
    }

    await applySubscriptionChange(
      {
        shopId: syncResult.shopId,
        subscriptionId: syncResult.subscriptionId,
        planKey: syncResult.planCode,
        interval: subscription.billingInterval as PrismaBillingInterval,
        externalSubscriptionId: subscription.externalSubscriptionId ?? undefined,
      },
      db,
    );

    log.info(
      { shopId: syncResult.shopId, planCode: syncResult.planCode },
      'applySubscriptionChangeFromSync: 实时额度发放完成',
    );
    return true;
  } catch (error) {
    log.error(
      { shopId: syncResult.shopId, planCode: syncResult.planCode, err: error },
      'applySubscriptionChangeFromSync: 实时额度发放失败，等待定时任务兜底',
    );
    return false;
  }
}
