/**
 * File: worker/jobs/billing-sync.job.ts
 * Purpose: Billing 定时同步批量 Job —— 兜底同步所有店铺的 Shopify 订阅状态。
 *          通过定时同步处理漏掉的 callback / webhook，确保本地订阅状态最终一致。
 *
 * ### 流程
 * 1. 查询所有有 Shopify session（含 accessToken）且未卸载的 shop。
 * 2. 对每个 shop 调用 syncSubscriptionFromShopify 同步订阅状态。
 * 3. 如发现变化（changed=true），调用 applySubscriptionChange 处理额度发放。
 * 4. 单个 shop 失败不影响其他 shop（catch + continue）。
 *
 * ### 幂等保证
 * - syncSubscriptionFromShopify：通过 externalSubscriptionId 唯一约束幂等。
 * - applySubscriptionChange：通过 grantCreditBucket 的 (shopId + bucketType + cycleKey) 唯一约束幂等。
 * - 不重复发放 included bucket、首次付费欢迎额度。
 *
 * ### 调度频率
 * 默认每 6 小时执行一次，由 billing-sync.scheduler.ts 注册 BullMQ repeatable job。
 */

import type { PrismaClient, BillingInterval as PrismaBillingInterval } from '@prisma/client';

import { createLogger } from '../../server/utils/logger.js';
import { syncSubscriptionFromShopify } from '../../server/modules/billing/subscription.service.js';
import type { SyncSubscriptionResult } from '../../server/modules/billing/subscription.service.js';
import { applySubscriptionChange } from '../../server/modules/billing/apply-subscription-change.server.js';
import type { PlanKey } from '../../server/modules/billing/billing.types.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'billing-sync-job' });

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 单个 shop 的同步结果 */
interface ShopSyncResult {
  /** 店铺域名 */
  shopDomain: string;
  /** 是否同步成功 */
  success: boolean;
  /** 是否发现变更 */
  changed: boolean;
  /** 是否应用了变更（调用了 applySubscriptionChange） */
  applied: boolean;
  /** 错误信息（失败时） */
  errorMessage?: string;
}

/** 批量同步结果摘要 */
export interface BillingSyncBatchResult {
  /** 总 shop 数 */
  total: number;
  /** 同步成功数 */
  synced: number;
  /** 发现变更的 shop 数 */
  changed: number;
  /** 成功应用变更的 shop 数 */
  applied: number;
  /** 失败数 */
  failed: number;
  /** 各 shop 详细结果 */
  details: ShopSyncResult[];
}

/** 可注入的依赖（用于测试） */
export interface BillingSyncDeps {
  /** 订阅同步函数（默认使用 syncSubscriptionFromShopify） */
  syncFn: typeof syncSubscriptionFromShopify;
  /** 订阅变更处理函数（默认使用 applySubscriptionChange） */
  applyFn: typeof applySubscriptionChange;
}

// ----------------------------------------------------------------------------
// 核心服务：批量同步所有 shop 的订阅状态
// ----------------------------------------------------------------------------

/**
 * 批量同步所有有 Shopify session 的 shop 的订阅状态。
 *
 * ### 流程
 * 1. 查询所有有 accessToken 且未卸载的 shop
 * 2. 逐个同步 Shopify 订阅状态到本地
 * 3. 如发现变化，调用 applySubscriptionChange 处理额度发放
 * 4. 单个 shop 失败不影响其他 shop
 *
 * @param client  可选 PrismaClient（默认使用全局单例，测试可注入）
 * @param deps    可选依赖注入（用于测试 mock）
 */
export async function syncAllShopsBilling(
  client?: PrismaClient,
  deps?: Partial<BillingSyncDeps>,
): Promise<BillingSyncBatchResult> {
  // 懒加载全局 Prisma 单例
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../server/db/prisma.server.js')).default;

  const syncFn = deps?.syncFn ?? syncSubscriptionFromShopify;
  const applyFn = deps?.applyFn ?? applySubscriptionChange;

  // ---- 1. 查询所有活跃 shop ----
  const shops = await db.shop.findMany({
    where: {
      accessTokenEncrypted: { not: null as unknown as string },
      uninstalledAt: null,
    },
    select: {
      id: true,
      shopDomain: true,
    },
  });

  log.info({ shopCount: shops.length }, 'billing-sync.job.start');

  // ---- 2. 逐个同步 ----
  const details: ShopSyncResult[] = [];
  let synced = 0;
  let changed = 0;
  let applied = 0;
  let failed = 0;

  for (const shop of shops) {
    const shopResult: ShopSyncResult = {
      shopDomain: shop.shopDomain,
      success: false,
      changed: false,
      applied: false,
    };

    try {
      // 2a. 同步订阅状态
      const syncResult = await syncFn(shop.shopDomain, undefined, db);

      shopResult.success = true;
      shopResult.changed = syncResult.changed;
      synced++;

      log.info(
        {
          shopDomain: shop.shopDomain,
          shopId: shop.id,
          created: syncResult.created,
          changed: syncResult.changed,
          planCode: syncResult.planCode,
          status: syncResult.status,
        },
        'billing-sync.job.shop.synced',
      );

      // 2b. 发现变更 → 调用 applySubscriptionChange
      if (syncResult.changed) {
        changed++;
        const applyResult = await applyChangeForShop(
          shop.id,
          syncResult,
          db,
          applyFn,
        );
        shopResult.applied = applyResult;
        if (applyResult) {
          applied++;
        }
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      shopResult.errorMessage = message;

      log.error(
        { shopDomain: shop.shopDomain, shopId: shop.id, err: error },
        'billing-sync.job.shop.failed',
      );
    }

    details.push(shopResult);
  }

  const result: BillingSyncBatchResult = {
    total: shops.length,
    synced,
    changed,
    applied,
    failed,
    details,
  };

  log.info(
    {
      total: result.total,
      synced: result.synced,
      changed: result.changed,
      applied: result.applied,
      failed: result.failed,
    },
    'billing-sync.job.completed',
  );

  return result;
}

// ----------------------------------------------------------------------------
// 内部辅助：对单个 shop 应用订阅变更
// ----------------------------------------------------------------------------

/**
 * 对单个 shop 应用订阅变更（额度发放、标记位更新）。
 *
 * @returns true 表示成功应用，false 表示跳过或失败
 */
async function applyChangeForShop(
  shopId: string,
  syncResult: SyncSubscriptionResult,
  db: PrismaClient,
  applyFn: typeof applySubscriptionChange,
): Promise<boolean> {
  try {
    // 查询订阅记录获取 interval 和 externalSubscriptionId
    const subscription = await db.billingSubscription.findUnique({
      where: { id: syncResult.subscriptionId },
      select: {
        billingInterval: true,
        externalSubscriptionId: true,
      },
    });

    if (!subscription) {
      log.warn(
        { shopId, subscriptionId: syncResult.subscriptionId },
        'billing-sync.job.apply.subscription_not_found',
      );
      return false;
    }

    await applyFn(
      {
        shopId,
        subscriptionId: syncResult.subscriptionId,
        planKey: syncResult.planCode as PlanKey,
        interval: subscription.billingInterval as PrismaBillingInterval,
        externalSubscriptionId: subscription.externalSubscriptionId ?? undefined,
      },
      db,
    );

    log.info(
      { shopId, planCode: syncResult.planCode },
      'billing-sync.job.apply.success',
    );

    return true;
  } catch (error) {
    log.error(
      { shopId, planCode: syncResult.planCode, err: error },
      'billing-sync.job.apply.failed',
    );
    return false;
  }
}
