/**
 * File: tests/billing-sync.job.test.ts
 * Purpose: syncAllShopsBilling 单元测试 —— 通过 mock 依赖验证批量同步核心逻辑。
 *
 * 测试覆盖：
 *   1. 无活跃 shop → 返回空结果
 *   2. 所有 shop 无变更 → synced 正确，changed=0
 *   3. 发现变更 → 调用 applyFn 正确处理
 *   4. 单个 shop 同步失败 → 不影响其他 shop
 *   5. applyFn 失败 → 不计入 applied，不影响其他 shop
 *   6. 混合场景：部分变更、部分失败
 *   7. 幂等：重复执行不产生副作用（由 syncFn/applyFn 幂等保证）
 *
 * Usage: npx tsx tests/billing-sync.job.test.ts
 */

export {};

// ============================================================================
// Mock 基础设施
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

// ============================================================================
// Mock 类型定义
// ============================================================================

/** 模拟的 shop 记录 */
interface MockShop {
  id: string;
  shopDomain: string;
}

/** 模拟的 billing_subscription 记录 */
interface MockSubscription {
  id: string;
  billingInterval: string;
  externalSubscriptionId: string | null;
}

/** syncFn 返回的同步结果 */
interface MockSyncResult {
  created: boolean;
  changed: boolean;
  subscriptionId: string;
  planCode: string;
  status: string;
}

/** 每个 shop 的 mock 配置 */
interface MockShopConfig {
  shop: MockShop;
  /** syncFn 返回结果；不提供则抛出异常 */
  syncResult?: MockSyncResult;
  /** syncFn 抛出的错误信息 */
  syncError?: string;
  /** 当 changed=true 时，subscription 查询结果 */
  subscription?: MockSubscription;
  /** applyFn 是否成功；默认 true */
  applySuccess?: boolean;
  /** applyFn 抛出的错误信息 */
  applyError?: string;
}

// ============================================================================
// Mock 工厂
// ============================================================================

/**
 * 创建 Mock PrismaClient。
 */
function createMockPrisma(configs: MockShopConfig[]) {
  const shopMap = new Map(configs.map((c) => [c.shop.shopDomain, c]));

  return {
    shop: {
      findMany: async () => configs.map((c) => c.shop),
    },
    billingSubscription: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        for (const config of configs) {
          if (config.subscription && config.subscription.id === where.id) {
            return config.subscription;
          }
        }
        return null;
      },
    },
  };
}

/**
 * 创建 mock syncFn。
 * 记录调用参数，根据配置返回结果或抛出异常。
 */
function createMockSyncFn(configs: MockShopConfig[]) {
  const calls: string[] = [];

  const fn = async (shopDomain: string) => {
    calls.push(shopDomain);
    const config = configs.find((c) => c.shop.shopDomain === shopDomain);

    if (!config) {
      throw new Error(`[mock] 未预期的 shopDomain: ${shopDomain}`);
    }

    if (config.syncError) {
      throw new Error(config.syncError);
    }

    return {
      created: config.syncResult?.created ?? false,
      changed: config.syncResult?.changed ?? false,
      subscriptionId: config.syncResult?.subscriptionId ?? 'sub-default',
      planCode: config.syncResult?.planCode ?? 'FREE',
      status: config.syncResult?.status ?? 'ACTIVE',
    };
  };

  return { fn, calls };
}

/**
 * 创建 mock applyFn。
 * 记录调用参数，根据配置返回结果或抛出异常。
 */
function createMockApplyFn(configs: MockShopConfig[]) {
  const calls: Array<{ shopId: string; planKey: string; subscriptionId: string }> = [];

  const fn = async (params: { shopId: string; planKey: string; subscriptionId: string }) => {
    calls.push({
      shopId: params.shopId,
      planKey: params.planKey,
      subscriptionId: params.subscriptionId,
    });

    const config = configs.find((c) => c.shop.id === params.shopId);
    if (config?.applyError) {
      throw new Error(config.applyError);
    }

    // 返回一个模拟结果
    return {
      included: { created: true, bucketId: 'bucket-mock' },
      welcome: null,
      freeMonthly: null,
      incrementalScanEnabled: true,
    };
  };

  return { fn, calls };
}

// ============================================================================
// 测试运行器
// ============================================================================

async function runTests() {
  console.log('\n📦 billing-sync.job 测试\n');

  // 动态导入被测模块
  const { syncAllShopsBilling } = await import('../worker/jobs/billing-sync.job.js');

  // ========================================================================
  // 测试 1: 无活跃 shop → 返回空结果
  // ========================================================================
  console.log('--- 无活跃 shop ---');

  const emptyMock = createMockPrisma([]);
  const emptySync = createMockSyncFn([]);
  const emptyApply = createMockApplyFn([]);

  const result1 = await syncAllShopsBilling(emptyMock as never, {
    syncFn: emptySync.fn as never,
    applyFn: emptyApply.fn as never,
  });

  assert(result1.total === 0, `total = 0`);
  assert(result1.synced === 0, `synced = 0`);
  assert(result1.changed === 0, `changed = 0`);
  assert(result1.applied === 0, `applied = 0`);
  assert(result1.failed === 0, `failed = 0`);
  assert(result1.details.length === 0, `details 为空`);

  // ========================================================================
  // 测试 2: 所有 shop 无变更 → synced 正确，changed=0
  // ========================================================================
  console.log('\n--- 所有 shop 无变更 ---');

  const noChangeConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-A', planCode: 'FREE', status: 'ACTIVE' },
    },
    {
      shop: { id: 'shop-B', shopDomain: 'shop-b.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-B', planCode: 'STARTER', status: 'ACTIVE' },
    },
  ];

  const noChangeMock = createMockPrisma(noChangeConfigs);
  const noChangeSync = createMockSyncFn(noChangeConfigs);
  const noChangeApply = createMockApplyFn(noChangeConfigs);

  const result2 = await syncAllShopsBilling(noChangeMock as never, {
    syncFn: noChangeSync.fn as never,
    applyFn: noChangeApply.fn as never,
  });

  assert(result2.total === 2, `total = 2`);
  assert(result2.synced === 2, `synced = 2`);
  assert(result2.changed === 0, `changed = 0（无变更）`);
  assert(result2.applied === 0, `applied = 0（无需 apply）`);
  assert(result2.failed === 0, `failed = 0`);
  assert(noChangeApply.calls.length === 0, `applyFn 未被调用`);

  // ========================================================================
  // 测试 3: 发现变更 → 调用 applyFn 正确处理
  // ========================================================================
  console.log('\n--- 发现变更并应用 ---');

  const changedConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-A-new', planCode: 'STARTER', status: 'ACTIVE' },
      subscription: { id: 'sub-A-new', billingInterval: 'MONTHLY', externalSubscriptionId: 'gid://shopify/AppSubscription/111' },
    },
  ];

  const changedMock = createMockPrisma(changedConfigs);
  const changedSync = createMockSyncFn(changedConfigs);
  const changedApply = createMockApplyFn(changedConfigs);

  const result3 = await syncAllShopsBilling(changedMock as never, {
    syncFn: changedSync.fn as never,
    applyFn: changedApply.fn as never,
  });

  assert(result3.total === 1, `total = 1`);
  assert(result3.synced === 1, `synced = 1`);
  assert(result3.changed === 1, `changed = 1`);
  assert(result3.applied === 1, `applied = 1`);
  assert(result3.failed === 0, `failed = 0`);
  assert(changedApply.calls.length === 1, `applyFn 被调用 1 次`);
  assert(changedApply.calls[0].shopId === 'shop-A', `applyFn shopId = shop-A`);
  assert(changedApply.calls[0].planKey === 'STARTER', `applyFn planKey = STARTER`);
  assert(result3.details[0].applied === true, `details[0].applied = true`);

  // ========================================================================
  // 测试 4: 单个 shop 同步失败 → 不影响其他 shop
  // ========================================================================
  console.log('\n--- 部分同步失败 ---');

  const partialFailConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-A', planCode: 'FREE', status: 'ACTIVE' },
    },
    {
      shop: { id: 'shop-B', shopDomain: 'shop-b.myshopify.com' },
      syncError: 'Shopify API 超时',
    },
    {
      shop: { id: 'shop-C', shopDomain: 'shop-c.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-C-new', planCode: 'GROWTH', status: 'ACTIVE' },
      subscription: { id: 'sub-C-new', billingInterval: 'ANNUAL', externalSubscriptionId: 'gid://shopify/AppSubscription/333' },
    },
  ];

  const partialFailMock = createMockPrisma(partialFailConfigs);
  const partialFailSync = createMockSyncFn(partialFailConfigs);
  const partialFailApply = createMockApplyFn(partialFailConfigs);

  const result4 = await syncAllShopsBilling(partialFailMock as never, {
    syncFn: partialFailSync.fn as never,
    applyFn: partialFailApply.fn as never,
  });

  assert(result4.total === 3, `total = 3`);
  assert(result4.synced === 2, `synced = 2（shop-A 和 shop-C 成功）`);
  assert(result4.changed === 1, `changed = 1（仅 shop-C）`);
  assert(result4.applied === 1, `applied = 1（shop-C 成功应用）`);
  assert(result4.failed === 1, `failed = 1（shop-B 失败）`);
  assert(result4.details[1].success === false, `shop-B success = false`);
  assert(result4.details[1].errorMessage === 'Shopify API 超时', `shop-B error message 正确`);
  assert(result4.details[2].applied === true, `shop-C applied = true`);

  // ========================================================================
  // 测试 5: applyFn 失败 → 不计入 applied
  // ========================================================================
  console.log('\n--- applyFn 失败 ---');

  const applyFailConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-A-new', planCode: 'PRO', status: 'ACTIVE' },
      subscription: { id: 'sub-A-new', billingInterval: 'MONTHLY', externalSubscriptionId: 'gid://shopify/AppSubscription/444' },
      applyError: '额度发放失败',
    },
  ];

  const applyFailMock = createMockPrisma(applyFailConfigs);
  const applyFailSync = createMockSyncFn(applyFailConfigs);
  const applyFailApply = createMockApplyFn(applyFailConfigs);

  const result5 = await syncAllShopsBilling(applyFailMock as never, {
    syncFn: applyFailSync.fn as never,
    applyFn: applyFailApply.fn as never,
  });

  assert(result5.total === 1, `total = 1`);
  assert(result5.synced === 1, `synced = 1（同步本身成功）`);
  assert(result5.changed === 1, `changed = 1（发现了变更）`);
  assert(result5.applied === 0, `applied = 0（apply 失败）`);
  assert(result5.details[0].success === true, `同步成功`);
  assert(result5.details[0].changed === true, `发现了变更`);
  assert(result5.details[0].applied === false, `apply 失败`);

  // ========================================================================
  // 测试 6: subscription 未找到 → applied=false，不抛异常
  // ========================================================================
  console.log('\n--- subscription 未找到 ---');

  const noSubConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-gone', planCode: 'STARTER', status: 'ACTIVE' },
      // 不提供 subscription → findUnique 返回 null
    },
  ];

  const noSubMock = createMockPrisma(noSubConfigs);
  const noSubSync = createMockSyncFn(noSubConfigs);
  const noSubApply = createMockApplyFn(noSubConfigs);

  const result6 = await syncAllShopsBilling(noSubMock as never, {
    syncFn: noSubSync.fn as never,
    applyFn: noSubApply.fn as never,
  });

  assert(result6.synced === 1, `synced = 1`);
  assert(result6.changed === 1, `changed = 1`);
  assert(result6.applied === 0, `applied = 0（subscription 不存在）`);
  assert(result6.failed === 0, `failed = 0（不视为失败）`);
  assert(result6.details[0].applied === false, `applied = false`);
  assert(noSubApply.calls.length === 0, `applyFn 未被调用`);

  // ========================================================================
  // 测试 7: 混合场景 — 多 shop 不同状态
  // ========================================================================
  console.log('\n--- 混合场景 ---');

  const mixedConfigs: MockShopConfig[] = [
    // shop-1: 无变更
    {
      shop: { id: 'shop-1', shopDomain: 'shop-1.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-1', planCode: 'FREE', status: 'ACTIVE' },
    },
    // shop-2: 升级到 STARTER
    {
      shop: { id: 'shop-2', shopDomain: 'shop-2.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-2-new', planCode: 'STARTER', status: 'ACTIVE' },
      subscription: { id: 'sub-2-new', billingInterval: 'MONTHLY', externalSubscriptionId: 'gid://shopify/AppSubscription/222' },
    },
    // shop-3: 同步失败
    {
      shop: { id: 'shop-3', shopDomain: 'shop-3.myshopify.com' },
      syncError: '网络错误',
    },
    // shop-4: 升级到 PRO（年付）
    {
      shop: { id: 'shop-4', shopDomain: 'shop-4.myshopify.com' },
      syncResult: { created: true, changed: true, subscriptionId: 'sub-4-new', planCode: 'PRO', status: 'ACTIVE' },
      subscription: { id: 'sub-4-new', billingInterval: 'ANNUAL', externalSubscriptionId: 'gid://shopify/AppSubscription/444' },
    },
    // shop-5: 状态变更但 apply 失败
    {
      shop: { id: 'shop-5', shopDomain: 'shop-5.myshopify.com' },
      syncResult: { created: false, changed: true, subscriptionId: 'sub-5', planCode: 'GROWTH', status: 'ACTIVE' },
      subscription: { id: 'sub-5', billingInterval: 'MONTHLY', externalSubscriptionId: 'gid://shopify/AppSubscription/555' },
      applyError: 'DB 写入失败',
    },
  ];

  const mixedMock = createMockPrisma(mixedConfigs);
  const mixedSync = createMockSyncFn(mixedConfigs);
  const mixedApply = createMockApplyFn(mixedConfigs);

  const result7 = await syncAllShopsBilling(mixedMock as never, {
    syncFn: mixedSync.fn as never,
    applyFn: mixedApply.fn as never,
  });

  assert(result7.total === 5, `total = 5`);
  assert(result7.synced === 4, `synced = 4（排除 shop-3）`);
  assert(result7.changed === 3, `changed = 3（shop-2, shop-4, shop-5）`);
  assert(result7.applied === 2, `applied = 2（shop-2, shop-4 成功；shop-5 失败）`);
  assert(result7.failed === 1, `failed = 1（shop-3）`);
  assert(mixedSync.calls.length === 5, `syncFn 被调用 5 次（所有 shop）`);
  assert(mixedApply.calls.length === 3, `applyFn 被调用 3 次（变更的 shop）`);

  // 验证 applyFn 的参数
  assert(mixedApply.calls[0].shopId === 'shop-2', `applyFn call[0] shopId = shop-2`);
  assert(mixedApply.calls[0].planKey === 'STARTER', `applyFn call[0] planKey = STARTER`);
  assert(mixedApply.calls[1].shopId === 'shop-4', `applyFn call[1] shopId = shop-4`);
  assert(mixedApply.calls[1].planKey === 'PRO', `applyFn call[1] planKey = PRO`);
  assert(mixedApply.calls[2].shopId === 'shop-5', `applyFn call[2] shopId = shop-5`);

  // ========================================================================
  // 测试 8: 幂等 — 无变更时 applyFn 完全不被调用
  // ========================================================================
  console.log('\n--- 幂等验证 ---');

  const idempotentConfigs: MockShopConfig[] = [
    {
      shop: { id: 'shop-A', shopDomain: 'shop-a.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-A', planCode: 'STARTER', status: 'ACTIVE' },
    },
    {
      shop: { id: 'shop-B', shopDomain: 'shop-b.myshopify.com' },
      syncResult: { created: false, changed: false, subscriptionId: 'sub-B', planCode: 'PRO', status: 'ACTIVE' },
    },
  ];

  const idempotentMock = createMockPrisma(idempotentConfigs);
  const idempotentSync = createMockSyncFn(idempotentConfigs);
  const idempotentApply = createMockApplyFn(idempotentConfigs);

  // 连续执行两次
  const result8a = await syncAllShopsBilling(idempotentMock as never, {
    syncFn: idempotentSync.fn as never,
    applyFn: idempotentApply.fn as never,
  });

  const result8b = await syncAllShopsBilling(idempotentMock as never, {
    syncFn: idempotentSync.fn as never,
    applyFn: idempotentApply.fn as never,
  });

  assert(result8a.changed === 0, `首次执行 changed = 0`);
  assert(result8a.applied === 0, `首次执行 applied = 0`);
  assert(result8b.changed === 0, `二次执行 changed = 0`);
  assert(result8b.applied === 0, `二次执行 applied = 0`);
  assert(idempotentApply.calls.length === 0, `applyFn 从未被调用（幂等）`);

  // ========================================================================
  // 结果汇总
  // ========================================================================
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
  console.log(`${'='.repeat(50)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error('测试运行失败:', error);
  process.exit(1);
});
