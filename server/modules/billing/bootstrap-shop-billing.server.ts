/**
 * File: server/modules/billing/bootstrap-shop-billing.server.ts
 * Purpose: 新安装店铺默认额度初始化服务。
 *          在 OAuth/install 完成后被调用，为店铺创建 Free 计划订阅、
 *          发放安装欢迎额度 (WELCOME 50) 和当月 Free 配额 (FREE_MONTHLY_INCLUDED 25)。
 *
 * 设计要点：
 *   - 全部逻辑幂等：重复调用不会重复发放额度或重复创建订阅。
 *   - 使用 grantCreditBucket 统一发放（附带 GRANT ledger 写入）。
 *   - 使用 plan-config 常量确保额度数量和 cycleKey 格式一致。
 */

import type { PrismaClient } from '@prisma/client';

import { createLogger } from '../../utils/logger.js';
import { grantCreditBucket } from './credit/grant-credit.server.js';
import {
  getFreeCycleKey,
  getInstallWelcomeCredits,
  getInstallWelcomeCycleKey,
} from './plan-config.js';
import { getPlanConfig } from './plan-config.js';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'bootstrap-shop-billing' });

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

/** Free 计划月配额 */
const FREE_MONTHLY_CREDITS = 25;

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 初始化结果 */
export interface BootstrapShopBillingResult {
  /** 创建或已存在的订阅 ID */
  subscriptionId: string;
  /** 本次是否新建了订阅 */
  subscriptionCreated: boolean;
  /** WELCOME bucket 发放结果 */
  welcome: {
    created: boolean;
    bucketId: string;
  };
  /** FREE_MONTHLY_INCLUDED bucket 发放结果 */
  monthly: {
    created: boolean;
    bucketId: string;
  };
}

// ----------------------------------------------------------------------------
// 核心实现
// ----------------------------------------------------------------------------

/**
 * 为新安装店铺初始化计费与额度。
 *
 * ### 流程
 * 1. 创建或查找 `billing_subscription`（FREE, NONE, ACTIVE）
 * 2. 发放安装欢迎额度：WELCOME(50), cycleKey = `WELCOME:INSTALL`
 * 3. 发放当月 Free 配额：FREE_MONTHLY_INCLUDED(25), cycleKey = `FREE:YYYY-MM`
 *
 * ### 幂等保证
 * - `billing_subscription`：通过 shopId + planCode + status 查找已存在记录。
 * - `credit_bucket`：通过 `grantCreditBucket` 的唯一约束实现幂等。
 *
 * @param shopId  店铺内部 ID（Prisma shops.id）
 * @param client  可选 PrismaClient 实例（默认使用全局单例）
 */
export async function bootstrapShopBilling(
  shopId: string,
  client?: PrismaClient,
): Promise<BootstrapShopBillingResult> {
  // ---- 参数校验 ----
  if (!shopId) {
    throw new Error('[bootstrap-shop-billing] shopId 不能为空');
  }

  // ---- 懒加载全局 Prisma 单例 ----
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../db/prisma.server.js')).default;

  const now = new Date();
  const freeConfig = getPlanConfig('FREE');

  log.info({ shopId }, '开始初始化店铺计费与额度');

  // ---- 1. 创建或查找 billing_subscription ----
  const existingSub = await db.billingSubscription.findFirst({
    where: {
      shopId,
      planCode: 'FREE',
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  let subscriptionId: string;
  let subscriptionCreated: boolean;

  if (existingSub) {
    subscriptionId = existingSub.id;
    subscriptionCreated = false;
    log.info({ shopId, subscriptionId }, 'Free 订阅已存在，跳过创建（幂等）');
  } else {
    const newSub = await db.billingSubscription.create({
      data: {
        shopId,
        planCode: 'FREE',
        billingInterval: 'NONE',
        status: 'ACTIVE',
        incrementalScanEnabled: freeConfig.incrementalScanEnabled,
        activatedAt: now,
      },
      select: { id: true },
    });
    subscriptionId = newSub.id;
    subscriptionCreated = true;
    log.info({ shopId, subscriptionId }, 'Free 订阅创建成功');
  }

  // ---- 2. 发放安装欢迎额度 WELCOME(50) ----
  const welcomeResult = await grantCreditBucket(
    {
      shopId,
      bucketType: 'WELCOME',
      amount: getInstallWelcomeCredits(),
      cycleKey: getInstallWelcomeCycleKey(),
      effectiveAt: now,
      expiresAt: null,
      billingSubscriptionId: subscriptionId,
      source: 'install',
      reason: '安装欢迎额度',
    },
    db,
  );

  // ---- 3. 发放当月 Free 配额 FREE_MONTHLY_INCLUDED(25) ----
  const freeCycleKey = getFreeCycleKey(now);
  // 当月 Free 配额到期时间：下月 1 日 UTC
  const expiresAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  const monthlyResult = await grantCreditBucket(
    {
      shopId,
      bucketType: 'FREE_MONTHLY_INCLUDED',
      amount: FREE_MONTHLY_CREDITS,
      cycleKey: freeCycleKey,
      effectiveAt: now,
      expiresAt,
      billingSubscriptionId: subscriptionId,
      source: 'install',
      reason: `${freeCycleKey} Free 月配额发放`,
    },
    db,
  );

  log.info(
    {
      shopId,
      subscriptionId,
      welcomeCreated: welcomeResult.created,
      monthlyCreated: monthlyResult.created,
    },
    '店铺计费与额度初始化完成',
  );

  return {
    subscriptionId,
    subscriptionCreated,
    welcome: {
      created: welcomeResult.created,
      bucketId: welcomeResult.bucket.id,
    },
    monthly: {
      created: monthlyResult.created,
      bucketId: monthlyResult.bucket.id,
    },
  };
}
