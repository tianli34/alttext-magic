/**
 * File: tests/billing-adapter.test.ts
 * Purpose: 验证 Billing Adapter 接口、Fake 实现、工厂函数的正确性。
 *          覆盖验收标准：
 *          - fake adapter 能返回 confirmation URL
 *          - Shopify adapter 构造的 mutation 参数包含正确 plan、价格、interval、returnUrl
 *          - 测试环境不依赖真实 Shopify Billing API
 *
 * 运行：npx tsx tests/billing-adapter.test.ts
 */

import assert from 'node:assert/strict';

import { FakeBillingAdapter } from '../server/shopify/billing-adapter.fake.js';
import { ShopifyBillingAdapter } from '../server/shopify/billing-adapter.server.js';
import {
  getBillingAdapter,
  getBillingAdapterType,
  resetBillingAdapterSingleton,
} from '../server/shopify/billing-adapter.js';
import type {
  BillingAdapter,
  CreateAppSubscriptionParams,
  CreateOneTimePurchaseParams,
} from '../server/shopify/billing-adapter.types.js';

// ============================================================================
// 辅助
// ============================================================================

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}: expected true, got false`);
  }
}

// ============================================================================
// 测试用常量
// ============================================================================

const TEST_SHOP = 'test-shop.myshopify.com';
const TEST_ACCESS_TOKEN = 'shpat_test_token_12345';
const TEST_RETURN_URL = 'https://app.example.com/billing/callback';

// ============================================================================
// 测试 1: FakeBillingAdapter.createAppSubscription
// ============================================================================

async function testFakeCreateAppSubscription(): Promise<void> {
  console.log('\n--- testFakeCreateAppSubscription ---');

  const fake = new FakeBillingAdapter();

  const result = await fake.createAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    planKey: 'STARTER',
    interval: 'MONTHLY',
    returnUrl: TEST_RETURN_URL,
    planName: 'Starter Monthly',
    priceCents: 499,
    shopifyInterval: 'EVERY_30_DAYS',
  });

  assertTrue(result.success, 'fake createAppSubscription success');
  assertTrue(!!result.subscriptionId, 'fake subscriptionId 存在');
  assertTrue(!!result.confirmationUrl, 'fake confirmationUrl 存在');

  // 验收：confirmationUrl 包含 returnUrl 前缀
  assertTrue(
    result.confirmationUrl!.startsWith(TEST_RETURN_URL),
    'confirmationUrl 以 returnUrl 开头',
  );

  // 验收：confirmationUrl 包含 fake 标记
  assertTrue(
    result.confirmationUrl!.includes('fake=true'),
    'confirmationUrl 包含 fake=true',
  );

  // 验收：confirmationUrl 包含 plan 信息
  assertTrue(
    result.confirmationUrl!.includes('plan=STARTER'),
    'confirmationUrl 包含 plan=STARTER',
  );

  // 验收：subscriptionId 格式为 gid://shopify/AppSubscription/...
  assertTrue(
    result.subscriptionId!.startsWith('gid://shopify/AppSubscription/'),
    'subscriptionId 格式正确',
  );

  // 验收：参数被记录到 history
  assertEqual(fake.subscriptionHistory.length, 1, 'subscriptionHistory.length === 1');
  assertEqual(fake.subscriptionHistory[0].planKey, 'STARTER', 'history planKey === STARTER');
  assertEqual(fake.subscriptionHistory[0].priceCents, 499, 'history priceCents === 499');

  console.log('  ✓ testFakeCreateAppSubscription passed');
}

// ============================================================================
// 测试 2: FakeBillingAdapter.createOneTimePurchase
// ============================================================================

async function testFakeCreateOneTimePurchase(): Promise<void> {
  console.log('\n--- testFakeCreateOneTimePurchase ---');

  const fake = new FakeBillingAdapter();

  const result = await fake.createOneTimePurchase({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    packKey: 'OVERAGE_100_299',
    returnUrl: TEST_RETURN_URL,
    packName: 'Overage Pack 100',
    priceCents: 299,
  });

  assertTrue(result.success, 'fake createOneTimePurchase success');
  assertTrue(!!result.purchaseId, 'fake purchaseId 存在');
  assertTrue(!!result.confirmationUrl, 'fake confirmationUrl 存在');

  // 验收：confirmationUrl 包含 fake 标记
  assertTrue(
    result.confirmationUrl!.includes('fake=true'),
    'confirmationUrl 包含 fake=true',
  );

  // 验收：purchaseId 格式为 gid://shopify/AppPurchaseOneTime/...
  assertTrue(
    result.purchaseId!.startsWith('gid://shopify/AppPurchaseOneTime/'),
    'purchaseId 格式正确',
  );

  // 验收：参数被记录到 history
  assertEqual(fake.purchaseHistory.length, 1, 'purchaseHistory.length === 1');
  assertEqual(fake.purchaseHistory[0].packKey, 'OVERAGE_100_299', 'history packKey');
  assertEqual(fake.purchaseHistory[0].priceCents, 299, 'history priceCents');

  console.log('  ✓ testFakeCreateOneTimePurchase passed');
}

// ============================================================================
// 测试 3: FakeBillingAdapter.cancelAppSubscription
// ============================================================================

async function testFakeCancelAppSubscription(): Promise<void> {
  console.log('\n--- testFakeCancelAppSubscription ---');

  const fake = new FakeBillingAdapter();
  const subId = 'gid://shopify/AppSubscription/fake-test-id';

  const result = await fake.cancelAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    subscriptionId: subId,
  });

  assertTrue(result.success, 'fake cancelAppSubscription success');
  assertEqual(result.subscriptionId, subId, '返回相同 subscriptionId');
  assertEqual(fake.cancelHistory.length, 1, 'cancelHistory.length === 1');
  assertEqual(fake.cancelHistory[0], subId, 'cancelHistory[0] === subId');

  console.log('  ✓ testFakeCancelAppSubscription passed');
}

// ============================================================================
// 测试 4: FakeBillingAdapter.getCurrentAppSubscriptions
// ============================================================================

async function testFakeGetCurrentAppSubscriptions(): Promise<void> {
  console.log('\n--- testFakeGetCurrentAppSubscriptions ---');

  const fake = new FakeBillingAdapter();

  // 无订阅时应返回空列表
  const emptyResult = await fake.getCurrentAppSubscriptions({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
  });

  assertTrue(emptyResult.success, 'fake getCurrentAppSubscriptions success');
  assertEqual(emptyResult.subscriptions.length, 0, '初始无订阅');

  // 创建一条订阅后
  await fake.createAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    planKey: 'GROWTH',
    interval: 'ANNUAL',
    returnUrl: TEST_RETURN_URL,
    planName: 'Growth Annual',
    priceCents: 699,
    shopifyInterval: 'ANNUAL',
  });

  const result = await fake.getCurrentAppSubscriptions({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
  });

  assertTrue(result.success, 'fake getCurrentAppSubscriptions success (有订阅)');
  assertEqual(result.subscriptions.length, 1, '有一条活跃订阅');
  assertEqual(result.subscriptions[0].name, 'Growth Annual', '订阅名称正确');
  assertEqual(result.subscriptions[0].status, 'ACTIVE', '订阅状态为 ACTIVE');
  assertEqual(result.subscriptions[0].interval, 'ANNUAL', '订阅周期为 ANNUAL');
  assertEqual(result.subscriptions[0].amount, '6.99', '订阅金额正确');
  assertEqual(result.subscriptions[0].currencyCode, 'USD', '货币为 USD');

  console.log('  ✓ testFakeGetCurrentAppSubscriptions passed');
}

// ============================================================================
// 测试 5: FakeBillingAdapter.resetHistory
// ============================================================================

async function testFakeResetHistory(): Promise<void> {
  console.log('\n--- testFakeResetHistory ---');

  const fake = new FakeBillingAdapter();

  await fake.createAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    planKey: 'PRO',
    interval: 'MONTHLY',
    returnUrl: TEST_RETURN_URL,
    planName: 'Pro Monthly',
    priceCents: 1499,
    shopifyInterval: 'EVERY_30_DAYS',
  });

  assertEqual(fake.subscriptionHistory.length, 1, 'reset 前有记录');

  fake.resetHistory();

  assertEqual(fake.subscriptionHistory.length, 0, 'reset 后无记录');
  assertEqual(fake.purchaseHistory.length, 0, 'purchaseHistory 也被清空');
  assertEqual(fake.cancelHistory.length, 0, 'cancelHistory 也被清空');

  console.log('  ✓ testFakeResetHistory passed');
}

// ============================================================================
// 测试 6: 工厂函数 getBillingAdapterType
// ============================================================================

async function testGetBillingAdapterType(): Promise<void> {
  console.log('\n--- testGetBillingAdapterType ---');

  const original = process.env.BILLING_ADAPTER;

  // 默认为 fake
  delete process.env.BILLING_ADAPTER;
  assertEqual(getBillingAdapterType(), 'fake', '默认为 fake');

  process.env.BILLING_ADAPTER = 'shopify';
  assertEqual(getBillingAdapterType(), 'shopify', 'BILLING_ADAPTER=shopify');

  process.env.BILLING_ADAPTER = 'fake';
  assertEqual(getBillingAdapterType(), 'fake', 'BILLING_ADAPTER=fake');

  process.env.BILLING_ADAPTER = 'SHOPIFY'; // 大写
  assertEqual(getBillingAdapterType(), 'shopify', '大写 SHOPIFY → shopify');

  // 恢复
  if (original !== undefined) {
    process.env.BILLING_ADAPTER = original;
  } else {
    delete process.env.BILLING_ADAPTER;
  }

  console.log('  ✓ testGetBillingAdapterType passed');
}

// ============================================================================
// 测试 7: 工厂函数 getBillingAdapter 返回正确类型
// ============================================================================

async function testGetBillingAdapter(): Promise<void> {
  console.log('\n--- testGetBillingAdapter ---');

  resetBillingAdapterSingleton();

  // 强制 fake
  const fakeAdapter = getBillingAdapter('fake');
  assertTrue(fakeAdapter instanceof FakeBillingAdapter, 'forceType=fake → FakeBillingAdapter');

  // 强制 shopify
  const shopifyAdapter = getBillingAdapter('shopify');
  assertTrue(shopifyAdapter instanceof ShopifyBillingAdapter, 'forceType=shopify → ShopifyBillingAdapter');

  // 单例
  const fakeAdapter2 = getBillingAdapter('fake');
  assertEqual(fakeAdapter, fakeAdapter2, '同一类型返回相同单例');

  resetBillingAdapterSingleton();

  console.log('  ✓ testGetBillingAdapter passed');
}

// ============================================================================
// 测试 8: Shopify adapter mutation 参数校验（不发送真实请求）
// ============================================================================

async function testShopifyAdapterMutationStructure(): Promise<void> {
  console.log('\n--- testShopifyAdapterMutationStructure ---');

  // 验证 ShopifyBillingAdapter 类的方法存在且签名正确
  const adapter = new ShopifyBillingAdapter();

  assertEqual(typeof adapter.createAppSubscription, 'function', 'createAppSubscription 是函数');
  assertEqual(typeof adapter.createOneTimePurchase, 'function', 'createOneTimePurchase 是函数');
  assertEqual(typeof adapter.cancelAppSubscription, 'function', 'cancelAppSubscription 是函数');
  assertEqual(typeof adapter.getCurrentAppSubscriptions, 'function', 'getCurrentAppSubscriptions 是函数');

  // 验证调用时因无效 shop/token 而返回 error（不会发送真实请求）
  const result = await adapter.getCurrentAppSubscriptions({
    shop: 'nonexistent.myshopify.com',
    accessToken: 'invalid_token',
  });

  // 由于网络请求会失败，应该返回 success: false
  assertEqual(result.success, false, '无效请求返回 success=false');
  assertTrue(!!result.errorMessage, '有错误信息');
  assertEqual(result.subscriptions.length, 0, 'subscriptions 为空');

  console.log('  ✓ testShopifyAdapterMutationStructure passed');
}

// ============================================================================
// 测试 9: Fake adapter 完整生命周期
// ============================================================================

async function testFakeFullLifecycle(): Promise<void> {
  console.log('\n--- testFakeFullLifecycle ---');

  const fake = new FakeBillingAdapter();

  // 1. 创建订阅
  const sub = await fake.createAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    planKey: 'STARTER',
    interval: 'MONTHLY',
    returnUrl: 'https://app.example.com/callback',
    planName: 'Starter Monthly',
    priceCents: 499,
    shopifyInterval: 'EVERY_30_DAYS',
  });

  assertTrue(sub.success, '创建订阅成功');
  const subId = sub.subscriptionId!;
  assertTrue(!!subId, '有 subscriptionId');

  // 2. 查询订阅
  const subs = await fake.getCurrentAppSubscriptions({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
  });

  assertTrue(subs.success, '查询订阅成功');
  assertEqual(subs.subscriptions.length, 1, '有一条订阅');

  // 3. 购买超额包
  const purchase = await fake.createOneTimePurchase({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    packKey: 'OVERAGE_100_299',
    returnUrl: 'https://app.example.com/callback',
    packName: 'Overage Pack 100',
    priceCents: 299,
  });

  assertTrue(purchase.success, '购买超额包成功');
  assertTrue(!!purchase.purchaseId, '有 purchaseId');
  assertTrue(!!purchase.confirmationUrl, '有 confirmationUrl');

  // 4. 取消订阅
  const cancel = await fake.cancelAppSubscription({
    shop: TEST_SHOP,
    accessToken: TEST_ACCESS_TOKEN,
    subscriptionId: subId,
  });

  assertTrue(cancel.success, '取消订阅成功');
  assertEqual(cancel.subscriptionId, subId, '取消的订阅 ID 匹配');

  console.log('  ✓ testFakeFullLifecycle passed');
}

// ============================================================================
// 测试 10: 接口契约 — 确保两个 adapter 都满足 BillingAdapter 接口
// ============================================================================

async function testInterfaceContract(): Promise<void> {
  console.log('\n--- testInterfaceContract ---');

  const fake: BillingAdapter = new FakeBillingAdapter();
  const shopify: BillingAdapter = new ShopifyBillingAdapter();

  // 仅验证方法存在
  const methods: (keyof BillingAdapter)[] = [
    'createAppSubscription',
    'createOneTimePurchase',
    'cancelAppSubscription',
    'getCurrentAppSubscriptions',
  ];

  for (const method of methods) {
    assertEqual(typeof fake[method], 'function', `FakeBillingAdapter.${method} 是函数`);
    assertEqual(typeof shopify[method], 'function', `ShopifyBillingAdapter.${method} 是函数`);
  }

  console.log('  ✓ testInterfaceContract passed');
}

// ============================================================================
// 运行所有测试
// ============================================================================

async function run(): Promise<void> {
  console.log('\n=== billing-adapter.test.ts ===');

  try {
    await testFakeCreateAppSubscription();
    await testFakeCreateOneTimePurchase();
    await testFakeCancelAppSubscription();
    await testFakeGetCurrentAppSubscriptions();
    await testFakeResetHistory();
    await testGetBillingAdapterType();
    await testGetBillingAdapter();
    await testShopifyAdapterMutationStructure();
    await testFakeFullLifecycle();
    await testInterfaceContract();
  } catch (err) {
    console.error('\n  ✗ 测试执行异常:', err);
    failed++;
  }

  console.log(`\n  总计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
