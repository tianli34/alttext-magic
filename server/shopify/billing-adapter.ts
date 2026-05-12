/**
 * File: server/shopify/billing-adapter.ts
 * Purpose: Billing Adapter 工厂入口。
 *          通过 BILLING_ADAPTER 环境变量切换真实/fake 实现。
 *
 * 用法：
 *   import { getBillingAdapter } from '../shopify/billing-adapter';
 *   const adapter = getBillingAdapter();
 *   const result = await adapter.createAppSubscription({ ... });
 */

import type { BillingAdapter, BillingAdapterType } from './billing-adapter.types.js';
import { FakeBillingAdapter } from './billing-adapter.fake.js';
import { ShopifyBillingAdapter } from './billing-adapter.server.js';

// ----------------------------------------------------------------------------
// 单例缓存
// ----------------------------------------------------------------------------

let _fakeInstance: FakeBillingAdapter | undefined;
let _shopifyInstance: ShopifyBillingAdapter | undefined;

// ----------------------------------------------------------------------------
// Adapter 类型判断
// ----------------------------------------------------------------------------

/**
 * 读取 BILLING_ADAPTER 环境变量，默认为 `fake`。
 * 允许值：`shopify` | `fake`
 */
export function getBillingAdapterType(): BillingAdapterType {
  const value = (process.env.BILLING_ADAPTER ?? 'fake').toLowerCase();
  if (value === 'shopify') return 'shopify';
  return 'fake';
}

// ----------------------------------------------------------------------------
// 工厂函数
// ----------------------------------------------------------------------------

/**
 * 获取 BillingAdapter 单例。
 * - `BILLING_ADAPTER=shopify` → 真实 Shopify Admin GraphQL
 * - `BILLING_ADAPTER=fake`    → Fake 实现（默认）
 *
 * @param forceType  强制指定类型，覆盖环境变量（仅用于测试）
 */
export function getBillingAdapter(forceType?: BillingAdapterType): BillingAdapter {
  const type = forceType ?? getBillingAdapterType();

  if (type === 'shopify') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!_shopifyInstance) {
      _shopifyInstance = new ShopifyBillingAdapter();
    }
    return _shopifyInstance;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!_fakeInstance) {
    _fakeInstance = new FakeBillingAdapter();
  }
  return _fakeInstance;
}

/**
 * 重置单例缓存（仅用于测试）。
 */
export function resetBillingAdapterSingleton(): void {
  _fakeInstance = undefined;
  _shopifyInstance = undefined;
}
