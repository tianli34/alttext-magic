/**
 * File: server/modules/billing/plan-change.service.ts
 * Purpose: 计划变更服务 —— 处理付费计划升级/切换和 Free 降级。
 *
 * ### 付费计划升级/切换
 * 调用 Shopify Billing API 创建订阅确认链接，用户确认后由 callback/webhook 完成实际切换。
 *
 * ### Free 降级
 * 取消活跃 Shopify 订阅，将本地 billing_subscription 标记为 CANCELED，
 * 创建新的 FREE 订阅并更新 shop.currentPlan。
 */
import type { PrismaClient } from '@prisma/client';

import { createLogger } from '../../utils/logger.js';
import { decryptToken } from '../../crypto/token-encryption.js';
import { getPlanConfig } from './plan-config.js';
import { ANNUAL_TOTAL_PRICE_CENTS } from '../../config/plans.js';
import type { BillingInterval, PlanKey } from './billing.types.js';
import type { BillingAdapter } from '../../shopify/billing-adapter.types.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'plan-change-service' });

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 付费计划变更参数 */
export interface ChangePlanToPaidParams {
  shopId: string;
  shopDomain: string;
  accessTokenEncrypted: string;
  accessTokenNonce: string;
  accessTokenTag: string;
  /** 付费计划标识（不含 FREE） */
  planKey: Exclude<PlanKey, 'FREE'>;
  interval: BillingInterval;
  /** 用户确认后回调 URL */
  returnUrl: string;
}

/** Free 降级参数 */
export interface ChangePlanToFreeParams {
  shopId: string;
  shopDomain: string;
  accessTokenEncrypted: string;
  accessTokenNonce: string;
  accessTokenTag: string;
}

/** 付费计划变更结果 */
export interface ChangePlanToPaidResult {
  confirmationUrl: string;
  subscriptionId: string;
}

/** Free 降级结果 */
export interface ChangePlanToFreeResult {
  /** 是否有被取消的 Shopify 订阅 */
  cancelledSubscription: boolean;
}

// ----------------------------------------------------------------------------
// 付费计划变更
// ----------------------------------------------------------------------------

/**
 * 处理付费计划变更（升级/切换）。
 * 调用 Shopify Billing API 创建订阅确认链接。
 *
 * @param params   变更参数
 * @param adapter  BillingAdapter 实例
 */
export async function changePlanToPaid(
  params: ChangePlanToPaidParams,
  adapter: BillingAdapter,
): Promise<ChangePlanToPaidResult> {
  const {
    shopId,
    shopDomain,
    accessTokenEncrypted,
    accessTokenNonce,
    accessTokenTag,
    planKey,
    interval,
    returnUrl,
  } = params;

  // 解密 access token
  const accessToken = decryptToken(
    accessTokenEncrypted,
    accessTokenNonce,
    accessTokenTag,
  );

  // 获取计划配置
  const config = getPlanConfig(planKey);

  // 根据计费周期确定价格
  const isAnnual = interval === 'ANNUAL';
  const priceCents = isAnnual
    ? ANNUAL_TOTAL_PRICE_CENTS[planKey]
    : config.monthlyPriceCents;

  // Shopify 侧的计费周期映射
  const shopifyInterval = isAnnual ? 'ANNUAL' as const : 'EVERY_30_DAYS' as const;

  // 显示名称，如 "Starter Monthly"
  const planName = `${config.displayName} ${isAnnual ? 'Annual' : 'Monthly'}`;

  log.info({ shopId, planKey, interval, priceCents }, '创建付费计划订阅');

  const result = await adapter.createAppSubscription({
    shop: shopDomain,
    accessToken,
    planKey,
    interval,
    returnUrl,
    planName,
    priceCents,
    shopifyInterval,
  });

  if (!result.success || !result.confirmationUrl) {
    const errMsg = result.errorMessage ?? 'Unknown billing error';
    const errCode = result.errorCode ?? 'UNKNOWN';
    log.error({ shopId, planKey, errCode, errMsg }, '创建 Shopify 订阅失败');
    throw new Error(`Failed to create subscription: ${errMsg}`);
  }

  log.info(
    { shopId, planKey, confirmationUrl: result.confirmationUrl },
    '订阅确认链接创建成功',
  );

  return {
    confirmationUrl: result.confirmationUrl,
    subscriptionId: result.subscriptionId ?? '',
  };
}

// ----------------------------------------------------------------------------
// Free 降级
// ----------------------------------------------------------------------------

/**
 * 处理降级到 Free 计划。
 * 1. 查询 Shopify 侧活跃订阅，逐个取消
 * 2. 将本地 billing_subscription 标记为 CANCELED
 * 3. 创建新的 FREE 订阅
 * 4. 更新 shop.currentPlan → FREE
 *
 * @param params   降级参数
 * @param adapter  BillingAdapter 实例
 * @param client   PrismaClient 实例
 */
export async function changePlanToFree(
  params: ChangePlanToFreeParams,
  adapter: BillingAdapter,
  client: PrismaClient,
): Promise<ChangePlanToFreeResult> {
  const {
    shopId,
    shopDomain,
    accessTokenEncrypted,
    accessTokenNonce,
    accessTokenTag,
  } = params;

  // 解密 access token
  const accessToken = decryptToken(
    accessTokenEncrypted,
    accessTokenNonce,
    accessTokenTag,
  );

  log.info({ shopId }, '开始降级到 Free 计划');

  // ---- 1. 查询 Shopify 侧活跃订阅并取消 ----
  const subsResult = await adapter.getCurrentAppSubscriptions({
    shop: shopDomain,
    accessToken,
  });

  let cancelledSubscription = false;

  if (subsResult.success && subsResult.subscriptions.length > 0) {
    for (const sub of subsResult.subscriptions) {
      if (sub.status === 'ACTIVE') {
        log.info(
          { shopId, subscriptionId: sub.id },
          '取消活跃 Shopify 订阅',
        );
        const cancelResult = await adapter.cancelAppSubscription({
          shop: shopDomain,
          accessToken,
          subscriptionId: sub.id,
        });
        if (cancelResult.success) {
          cancelledSubscription = true;
        } else {
          log.warn(
            { shopId, subscriptionId: sub.id, error: cancelResult.errorMessage },
            '取消 Shopify 订阅失败，继续本地降级',
          );
        }
      }
    }
  }

  // ---- 2. 本地数据库操作（事务） ----
  const now = new Date();
  const freeConfig = getPlanConfig('FREE');

  await client.$transaction(async (tx) => {
    // 2a. 将当前活跃订阅标记为 CANCELED
    const activeSubs = await tx.billingSubscription.findMany({
      where: { shopId, status: 'ACTIVE' },
      select: { id: true },
    });

    for (const sub of activeSubs) {
      await tx.billingSubscription.update({
        where: { id: sub.id },
        data: {
          status: 'CANCELED',
          canceledAt: now,
        },
      });
    }

    // 2b. 创建新的 FREE 订阅
    await tx.billingSubscription.create({
      data: {
        shopId,
        planCode: 'FREE',
        billingInterval: 'NONE',
        status: 'ACTIVE',
        incrementalScanEnabled: freeConfig.incrementalScanEnabled,
        activatedAt: now,
      },
    });

    // 2c. 更新 shop 的 currentPlan + 关闭增量扫描
    await tx.shop.update({
      where: { id: shopId },
      data: { currentPlan: 'FREE', incrementalScanEnabled: false },
    });
  });

  log.info(
    { shopId, cancelledSubscription },
    '降级到 Free 计划完成',
  );

  return { cancelledSubscription };
}
