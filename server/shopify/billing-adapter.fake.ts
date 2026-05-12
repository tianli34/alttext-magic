/**
 * File: server/shopify/billing-adapter.fake.ts
 * Purpose: Shopify Billing API Fake/Mock 实现。
 *          用于开发和测试环境，不调用真实 Shopify API。
 *          返回固定的 confirmation URL 和 fake Shopify ID。
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../utils/logger.js';
import type {
  BillingAdapter,
  CreateAppSubscriptionParams,
  CreateAppSubscriptionResult,
  CreateOneTimePurchaseParams,
  CreateOneTimePurchaseResult,
  CancelAppSubscriptionParams,
  CancelAppSubscriptionResult,
  GetCurrentAppSubscriptionsParams,
  GetCurrentAppSubscriptionsResult,
  ActiveSubscription,
} from './billing-adapter.types.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'billing-adapter:fake' });

// ----------------------------------------------------------------------------
// FakeBillingAdapter 实现
// ----------------------------------------------------------------------------

export class FakeBillingAdapter implements BillingAdapter {
  /** 保存最近创建的订阅，供测试断言 */
  private _subscriptionHistory: CreateAppSubscriptionParams[] = [];
  /** 保存最近创建的一次性购买，供测试断言 */
  private _purchaseHistory: CreateOneTimePurchaseParams[] = [];
  /** 保存最近取消的订阅 ID，供测试断言 */
  private _cancelHistory: string[] = [];

  // ------------------------------------------------------------------
  // createAppSubscription
  // ------------------------------------------------------------------

  async createAppSubscription(
    params: CreateAppSubscriptionParams,
  ): Promise<CreateAppSubscriptionResult> {
    const { shop, planKey, planName, priceCents, shopifyInterval, returnUrl } = params;

    log.info(
      { shop, planKey, planName, priceCents, shopifyInterval },
      '[FAKE] Creating app subscription',
    );

    this._subscriptionHistory.push(params);

    const fakeId = `gid://shopify/AppSubscription/${randomUUID()}`;
    const confirmationUrl = `${returnUrl}${
      returnUrl.includes('?') ? '&' : '?'
    }fake=true&subscription_id=${encodeURIComponent(fakeId)}&plan=${planKey}&interval=${shopifyInterval}`;

    return {
      success: true,
      subscriptionId: fakeId,
      confirmationUrl,
    };
  }

  // ------------------------------------------------------------------
  // createOneTimePurchase
  // ------------------------------------------------------------------

  async createOneTimePurchase(
    params: CreateOneTimePurchaseParams,
  ): Promise<CreateOneTimePurchaseResult> {
    const { shop, packKey, packName, priceCents, returnUrl } = params;

    log.info(
      { shop, packKey, packName, priceCents },
      '[FAKE] Creating one-time purchase',
    );

    this._purchaseHistory.push(params);

    const fakeId = `gid://shopify/AppPurchaseOneTime/${randomUUID()}`;
    const confirmationUrl = `${returnUrl}${
      returnUrl.includes('?') ? '&' : '?'
    }fake=true&purchase_id=${encodeURIComponent(fakeId)}&pack=${packKey}`;

    return {
      success: true,
      purchaseId: fakeId,
      confirmationUrl,
    };
  }

  // ------------------------------------------------------------------
  // cancelAppSubscription
  // ------------------------------------------------------------------

  async cancelAppSubscription(
    params: CancelAppSubscriptionParams,
  ): Promise<CancelAppSubscriptionResult> {
    const { shop, subscriptionId } = params;

    log.info({ shop, subscriptionId }, '[FAKE] Cancelling app subscription');

    this._cancelHistory.push(subscriptionId);

    return {
      success: true,
      subscriptionId,
    };
  }

  // ------------------------------------------------------------------
  // getCurrentAppSubscriptions
  // ------------------------------------------------------------------

  async getCurrentAppSubscriptions(
    params: GetCurrentAppSubscriptionsParams,
  ): Promise<GetCurrentAppSubscriptionsResult> {
    const { shop } = params;

    log.info({ shop }, '[FAKE] Querying current app subscriptions');

    // 默认返回空列表；如果之前通过本 adapter 创建过订阅，则返回最近一条
    const subscriptions: ActiveSubscription[] = [];

    if (this._subscriptionHistory.length > 0) {
      const last = this._subscriptionHistory[this._subscriptionHistory.length - 1];
      subscriptions.push({
        id: `gid://shopify/AppSubscription/fake-${last.planKey}`,
        name: last.planName,
        status: 'ACTIVE',
        test: true,
        interval: last.shopifyInterval,
        amount: (last.priceCents / 100).toFixed(2),
        currencyCode: 'USD',
      });
    }

    return { success: true, subscriptions };
  }

  // ------------------------------------------------------------------
  // 测试辅助方法
  // ------------------------------------------------------------------

  /** 获取最近创建订阅的参数记录 */
  get subscriptionHistory(): ReadonlyArray<CreateAppSubscriptionParams> {
    return this._subscriptionHistory;
  }

  /** 获取最近创建一次性购买的参数记录 */
  get purchaseHistory(): ReadonlyArray<CreateOneTimePurchaseParams> {
    return this._purchaseHistory;
  }

  /** 获取最近取消的订阅 ID 记录 */
  get cancelHistory(): ReadonlyArray<string> {
    return this._cancelHistory;
  }

  /** 清空所有历史记录 */
  resetHistory(): void {
    this._subscriptionHistory = [];
    this._purchaseHistory = [];
    this._cancelHistory = [];
  }
}
