/**
 * File: server/shopify/billing-adapter.server.ts
 * Purpose: Shopify Billing API 真实实现。
 *          通过 Shopify Admin GraphQL API 调用：
 *          - appSubscriptionCreate（周期性订阅）
 *          - appPurchaseOneTimeCreate（一次性购买 / 超额包）
 *          - appSubscriptionCancel（取消订阅）
 *          - currentAppInstallation.activeSubscriptions（查询活跃订阅）
 */

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
import { SHOPIFY_API_VERSION } from './billing-adapter.types.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'billing-adapter:shopify' });

// ----------------------------------------------------------------------------
// GraphQL 请求工具
// ----------------------------------------------------------------------------

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/**
 * 向 Shopify Admin GraphQL API 发送请求。
 *
 * @param shop       店铺域名
 * @param accessToken Offline Access Token
 * @param query      GraphQL 文档字符串
 * @param variables  变量对象
 */
async function shopifyGraphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlResponse<T>> {
  const endpoint = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[billing-adapter] Shopify GraphQL HTTP error: ${response.status} ${response.statusText} — ${text}`,
    );
  }

  return (await response.json()) as GraphqlResponse<T>;
}

// ----------------------------------------------------------------------------
// GraphQL 文档
// ----------------------------------------------------------------------------

/** appSubscriptionCreate mutation */
const APP_SUBSCRIPTION_CREATE_MUTATION = /* GraphQL */ `
  mutation appSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      lineItems: $lineItems
    ) {
      appSubscription {
        id
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

/** appPurchaseOneTimeCreate mutation */
const APP_PURCHASE_ONE_TIME_CREATE_MUTATION = /* GraphQL */ `
  mutation appPurchaseOneTimeCreate(
    $name: String!
    $price: MoneyInput!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appPurchaseOneTimeCreate(
      name: $name
      price: $price
      returnUrl: $returnUrl
      test: $test
    ) {
      appPurchaseOneTime {
        id
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

/** appSubscriptionCancel mutation */
const APP_SUBSCRIPTION_CANCEL_MUTATION = /* GraphQL */ `
  mutation appSubscriptionCancel(
    $id: ID!
  ) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** 查询当前活跃订阅 */
const CURRENT_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        interval
        amount
        currencyCode
      }
    }
  }
`;

// ----------------------------------------------------------------------------
// Helper：判断是否为测试模式
// ----------------------------------------------------------------------------

/**
 * 当 NODE_ENV 非 production 时自动启用 Shopify test mode，
 * 以避免真实扣款。
 */
function isTestMode(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ----------------------------------------------------------------------------
// ShopifyBillingAdapter 实现
// ----------------------------------------------------------------------------

export class ShopifyBillingAdapter implements BillingAdapter {
  // ------------------------------------------------------------------
  // createAppSubscription
  // ------------------------------------------------------------------

  async createAppSubscription(
    params: CreateAppSubscriptionParams,
  ): Promise<CreateAppSubscriptionResult> {
    const { shop, accessToken, planName, returnUrl, priceCents, shopifyInterval } = params;

    log.info({ shop, planName, shopifyInterval, priceCents }, 'Creating app subscription');

    const test = isTestMode();

    const lineItems = [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: (priceCents / 100).toFixed(2), currencyCode: 'USD' },
            interval: shopifyInterval,
          },
        },
      },
    ];

    try {
      const result = await shopifyGraphql<{
        appSubscriptionCreate: {
          appSubscription: { id: string } | null;
          confirmationUrl: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      }>(shop, accessToken, APP_SUBSCRIPTION_CREATE_MUTATION, {
        name: planName,
        returnUrl,
        test,
        lineItems,
      });

      if (result.errors?.length) {
        const errMsg = result.errors.map((e) => e.message).join('; ');
        log.error({ shop, errors: result.errors }, 'GraphQL error in appSubscriptionCreate');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: result.errors[0]?.extensions?.code,
        };
      }

      const data = result.data?.appSubscriptionCreate;
      if (!data) {
        return { success: false, errorMessage: 'Empty response from Shopify' };
      }

      if (data.userErrors.length > 0) {
        const errMsg = data.userErrors.map((e) => `${e.field ?? ''}: ${e.message}`).join('; ');
        log.warn({ shop, userErrors: data.userErrors }, 'User errors in appSubscriptionCreate');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: 'USER_ERROR',
        };
      }

      return {
        success: true,
        subscriptionId: data.appSubscription?.id ?? undefined,
        confirmationUrl: data.confirmationUrl ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ shop, err }, 'Exception in createAppSubscription');
      return { success: false, errorMessage: message };
    }
  }

  // ------------------------------------------------------------------
  // createOneTimePurchase
  // ------------------------------------------------------------------

  async createOneTimePurchase(
    params: CreateOneTimePurchaseParams,
  ): Promise<CreateOneTimePurchaseResult> {
    const { shop, accessToken, packName, returnUrl, priceCents } = params;

    log.info({ shop, packName, priceCents }, 'Creating one-time purchase');

    const test = isTestMode();

    try {
      const result = await shopifyGraphql<{
        appPurchaseOneTimeCreate: {
          appPurchaseOneTime: { id: string } | null;
          confirmationUrl: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      }>(shop, accessToken, APP_PURCHASE_ONE_TIME_CREATE_MUTATION, {
        name: packName,
        price: { amount: (priceCents / 100).toFixed(2), currencyCode: 'USD' },
        returnUrl,
        test,
      });

      if (result.errors?.length) {
        const errMsg = result.errors.map((e) => e.message).join('; ');
        log.error({ shop, errors: result.errors }, 'GraphQL error in appPurchaseOneTimeCreate');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: result.errors[0]?.extensions?.code,
        };
      }

      const data = result.data?.appPurchaseOneTimeCreate;
      if (!data) {
        return { success: false, errorMessage: 'Empty response from Shopify' };
      }

      if (data.userErrors.length > 0) {
        const errMsg = data.userErrors.map((e) => `${e.field ?? ''}: ${e.message}`).join('; ');
        log.warn({ shop, userErrors: data.userErrors }, 'User errors in appPurchaseOneTimeCreate');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: 'USER_ERROR',
        };
      }

      return {
        success: true,
        purchaseId: data.appPurchaseOneTime?.id ?? undefined,
        confirmationUrl: data.confirmationUrl ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ shop, err }, 'Exception in createOneTimePurchase');
      return { success: false, errorMessage: message };
    }
  }

  // ------------------------------------------------------------------
  // cancelAppSubscription
  // ------------------------------------------------------------------

  async cancelAppSubscription(
    params: CancelAppSubscriptionParams,
  ): Promise<CancelAppSubscriptionResult> {
    const { shop, accessToken, subscriptionId } = params;

    log.info({ shop, subscriptionId }, 'Cancelling app subscription');

    try {
      const result = await shopifyGraphql<{
        appSubscriptionCancel: {
          appSubscription: { id: string; status: string } | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      }>(shop, accessToken, APP_SUBSCRIPTION_CANCEL_MUTATION, {
        id: subscriptionId,
      });

      if (result.errors?.length) {
        const errMsg = result.errors.map((e) => e.message).join('; ');
        log.error({ shop, errors: result.errors }, 'GraphQL error in appSubscriptionCancel');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: result.errors[0]?.extensions?.code,
        };
      }

      const data = result.data?.appSubscriptionCancel;
      if (!data) {
        return { success: false, errorMessage: 'Empty response from Shopify' };
      }

      if (data.userErrors.length > 0) {
        const errMsg = data.userErrors.map((e) => `${e.field ?? ''}: ${e.message}`).join('; ');
        log.warn({ shop, userErrors: data.userErrors }, 'User errors in appSubscriptionCancel');
        return {
          success: false,
          errorMessage: errMsg,
          errorCode: 'USER_ERROR',
        };
      }

      return {
        success: true,
        subscriptionId: data.appSubscription?.id ?? subscriptionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ shop, err }, 'Exception in cancelAppSubscription');
      return { success: false, errorMessage: message };
    }
  }

  // ------------------------------------------------------------------
  // getCurrentAppSubscriptions
  // ------------------------------------------------------------------

  async getCurrentAppSubscriptions(
    params: GetCurrentAppSubscriptionsParams,
  ): Promise<GetCurrentAppSubscriptionsResult> {
    const { shop, accessToken } = params;

    log.info({ shop }, 'Querying current app subscriptions');

    try {
      const result = await shopifyGraphql<{
        currentAppInstallation: {
          activeSubscriptions: Array<{
            id: string;
            name: string;
            status: string;
            test: boolean;
            interval?: string;
            amount?: string;
            currencyCode?: string;
          }>;
        };
      }>(shop, accessToken, CURRENT_SUBSCRIPTIONS_QUERY, {});

      if (result.errors?.length) {
        const errMsg = result.errors.map((e) => e.message).join('; ');
        log.error({ shop, errors: result.errors }, 'GraphQL error in currentSubscriptions query');
        return { success: false, subscriptions: [], errorMessage: errMsg };
      }

      const rawSubs = result.data?.currentAppInstallation?.activeSubscriptions ?? [];

      const subscriptions: ActiveSubscription[] = rawSubs.map((sub) => ({
        id: sub.id,
        name: sub.name,
        status: sub.status as ActiveSubscription['status'],
        test: sub.test,
        interval: sub.interval as 'EVERY_30_DAYS' | 'ANNUAL' | undefined,
        amount: sub.amount,
        currencyCode: sub.currencyCode,
      }));

      log.info({ shop, count: subscriptions.length }, 'Queried active subscriptions');

      return { success: true, subscriptions };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ shop, err }, 'Exception in getCurrentAppSubscriptions');
      return { success: false, subscriptions: [], errorMessage: message };
    }
  }
}
