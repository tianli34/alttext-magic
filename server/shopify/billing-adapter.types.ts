/**
 * File: server/shopify/billing-adapter.types.ts
 * Purpose: Shopify Billing API Adapter 接口与类型定义。
 *          支持 appSubscriptionCreate / appPurchaseOneTimeCreate /
 *          appSubscriptionCancel / 当前活跃订阅查询。
 */

import type { BillingInterval, PlanKey } from '../modules/billing/billing.types';

// ============================================================================
// 通用
// ============================================================================

/** Shopify Admin GraphQL API 版本 */
export const SHOPIFY_API_VERSION = '2026-04';

/** Adapter 类型标识 */
export type BillingAdapterType = 'shopify' | 'fake';

// ============================================================================
// createAppSubscription 参数与返回值
// ============================================================================

export interface CreateAppSubscriptionParams {
  /** 店铺域名，如 `example.myshopify.com` */
  shop: string;
  /** Shopify Offline Access Token */
  accessToken: string;
  /** 计划标识，如 `STARTER`、`GROWTH` */
  planKey: PlanKey;
  /** 计费周期 */
  interval: BillingInterval;
  /** 用户确认后回调 URL */
  returnUrl: string;
  /** 计划名称（显示用），如 `Starter Monthly` */
  planName: string;
  /** 价格（美分） */
  priceCents: number;
  /** 年付时为 ANNUAL（Shopify AppSubscriptionInterval）, 月付为 EVERY_30_DAYS */
  shopifyInterval: 'EVERY_30_DAYS' | 'ANNUAL';
}

export interface CreateAppSubscriptionResult {
  /** 是否成功 */
  success: boolean;
  /** Shopify 返回的订阅 ID（gid://shopify/AppSubscription/xxx） */
  subscriptionId?: string;
  /** 用户确认支付的跳转 URL */
  confirmationUrl?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 错误码（如 `CHARGE_ALREADY_EXISTS`） */
  errorCode?: string;
}

// ============================================================================
// createOneTimePurchase 参数与返回值
// ============================================================================

export interface CreateOneTimePurchaseParams {
  /** 店铺域名 */
  shop: string;
  /** Shopify Offline Access Token */
  accessToken: string;
  /** 超额包标识，如 `OVERAGE_100_299` */
  packKey: string;
  /** 用户确认后回调 URL */
  returnUrl: string;
  /** 包名称（显示用），如 `Overage Pack 100` */
  packName: string;
  /** 价格（美分） */
  priceCents: number;
}

export interface CreateOneTimePurchaseResult {
  /** 是否成功 */
  success: boolean;
  /** Shopify 返回的购买 ID（gid://shopify/AppPurchaseOneTime/xxx） */
  purchaseId?: string;
  /** 用户确认支付的跳转 URL */
  confirmationUrl?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 错误码 */
  errorCode?: string;
}

// ============================================================================
// cancelAppSubscription 参数与返回值
// ============================================================================

export interface CancelAppSubscriptionParams {
  /** 店铺域名 */
  shop: string;
  /** Shopify Offline Access Token */
  accessToken: string;
  /** 要取消的订阅 ID（gid://shopify/AppSubscription/xxx） */
  subscriptionId: string;
}

export interface CancelAppSubscriptionResult {
  /** 是否成功 */
  success: boolean;
  /** 取消后的订阅 ID（与入参相同） */
  subscriptionId?: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 错误码 */
  errorCode?: string;
}

// ============================================================================
// getCurrentAppSubscriptions 参数与返回值
// ============================================================================

export interface GetCurrentAppSubscriptionsParams {
  /** 店铺域名 */
  shop: string;
  /** Shopify Offline Access Token */
  accessToken: string;
}

/** 单条活跃订阅信息 */
export interface ActiveSubscription {
  /** Shopify 订阅 GID */
  id: string;
  /** 计划名称 */
  name: string;
  /** 状态 */
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'FROZEN' | 'ACCEPTED' | 'DECLINED';
  /** 测试模式 */
  test: boolean;
  /** 计费周期 */
  interval?: 'EVERY_30_DAYS' | 'ANNUAL';
  /** 价格（小数格式，如 "4.99"） */
  amount?: string;
  /** 货币代码 */
  currencyCode?: string;
}

export interface GetCurrentAppSubscriptionsResult {
  /** 是否成功 */
  success: boolean;
  /** 活跃订阅列表 */
  subscriptions: ActiveSubscription[];
  /** 错误信息 */
  errorMessage?: string;
}

// ============================================================================
// BillingAdapter 接口
// ============================================================================

/**
 * Shopify Billing API Adapter 接口。
 * 真实实现调用 Shopify Admin GraphQL，Fake 实现返回固定值用于测试。
 */
export interface BillingAdapter {
  /** 创建周期性订阅 */
  createAppSubscription(
    params: CreateAppSubscriptionParams,
  ): Promise<CreateAppSubscriptionResult>;

  /** 创建一次性购买（超额包） */
  createOneTimePurchase(
    params: CreateOneTimePurchaseParams,
  ): Promise<CreateOneTimePurchaseResult>;

  /** 取消订阅 */
  cancelAppSubscription(
    params: CancelAppSubscriptionParams,
  ): Promise<CancelAppSubscriptionResult>;

  /** 查询当前活跃订阅 */
  getCurrentAppSubscriptions(
    params: GetCurrentAppSubscriptionsParams,
  ): Promise<GetCurrentAppSubscriptionsResult>;
}
