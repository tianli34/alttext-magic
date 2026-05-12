/**
 * File: server/config/plans.ts
 * Purpose: 五档计费计划的完整配置常量、超额包规格、欢迎额度配置。
 *          数据来源：docs/Specs/4.9 计费与配额.md §4.9.1
 */

import type {
  BillingInterval,
  InstallWelcomeConfig,
  OveragePackConfig,
  PaidWelcomeConfig,
  PlanConfig,
  PlanKey,
} from '../modules/billing/billing.types';

// ============================================================================
// 欢迎额度
// ============================================================================

/** 安装欢迎额度配置（所有店铺通用） */
export const INSTALL_WELCOME: InstallWelcomeConfig = {
  credits: 50,
  cycleKeyTag: 'WELCOME:INSTALL',
} as const;

/** 首次付费欢迎额度（按计划分级，仅一次） */
export const PAID_WELCOME_MAP: Readonly<Record<Exclude<PlanKey, 'FREE'>, PaidWelcomeConfig>> = {
  STARTER: { credits: 200, cycleKeyTag: 'PAID_WELCOME_STARTER' },
  GROWTH: { credits: 500, cycleKeyTag: 'PAID_WELCOME_GROWTH' },
  PRO: { credits: 1000, cycleKeyTag: 'PAID_WELCOME_PRO' },
  MAX: { credits: 3000, cycleKeyTag: 'PAID_WELCOME_MAX' },
} as const;

// ============================================================================
// 超额包规格
// ============================================================================

/**
 * 每档计划对应的超额包列表。
 * 按规格文档：各计划有不同的超额包规格（价格与额度）。
 */
const OVERAGE_PACK_FREE_STARTER: readonly OveragePackConfig[] = [
  { credits: 100, priceCents: 299, displayPrice: '$2.99', packCode: 'OVERAGE_100_299' },
] as const;

const OVERAGE_PACK_GROWTH: readonly OveragePackConfig[] = [
  { credits: 200, priceCents: 499, displayPrice: '$4.99', packCode: 'OVERAGE_200_499' },
] as const;

const OVERAGE_PACK_PRO: readonly OveragePackConfig[] = [
  { credits: 400, priceCents: 799, displayPrice: '$7.99', packCode: 'OVERAGE_400_799' },
] as const;

const OVERAGE_PACK_MAX: readonly OveragePackConfig[] = [
  { credits: 800, priceCents: 999, displayPrice: '$9.99', packCode: 'OVERAGE_800_999' },
] as const;

// ============================================================================
// 五档计划配置
// ============================================================================

/** 完整计划配置映射表 */
export const PLAN_CONFIGS: Readonly<Record<PlanKey, PlanConfig>> = {
  FREE: {
    planKey: 'FREE',
    displayName: 'Free',
    monthlyPriceCents: 0,
    annualMonthlyPriceCents: 0,
    monthlyQuota: 25,
    annualTotalCredits: 0,
    incrementalScanEnabled: false,
    overagePacks: OVERAGE_PACK_FREE_STARTER,
  },

  STARTER: {
    planKey: 'STARTER',
    displayName: 'Starter',
    monthlyPriceCents: 499,
    annualMonthlyPriceCents: 349,
    monthlyQuota: 150,
    annualTotalCredits: 150 * 12, // 1800
    incrementalScanEnabled: true,
    overagePacks: OVERAGE_PACK_FREE_STARTER,
    paidWelcome: PAID_WELCOME_MAP.STARTER,
  },

  GROWTH: {
    planKey: 'GROWTH',
    displayName: 'Growth',
    monthlyPriceCents: 999,
    annualMonthlyPriceCents: 699,
    monthlyQuota: 350,
    annualTotalCredits: 350 * 12, // 4200
    incrementalScanEnabled: true,
    overagePacks: OVERAGE_PACK_GROWTH,
    paidWelcome: PAID_WELCOME_MAP.GROWTH,
  },

  PRO: {
    planKey: 'PRO',
    displayName: 'Pro',
    monthlyPriceCents: 1499,
    annualMonthlyPriceCents: 1049,
    monthlyQuota: 800,
    annualTotalCredits: 800 * 12, // 9600
    incrementalScanEnabled: true,
    overagePacks: OVERAGE_PACK_PRO,
    paidWelcome: PAID_WELCOME_MAP.PRO,
  },

  MAX: {
    planKey: 'MAX',
    displayName: 'Max',
    monthlyPriceCents: 2499,
    annualMonthlyPriceCents: 1749,
    monthlyQuota: 2000,
    annualTotalCredits: 2000 * 12, // 24000
    incrementalScanEnabled: true,
    overagePacks: OVERAGE_PACK_MAX,
    paidWelcome: PAID_WELCOME_MAP.MAX,
  },
} as const;

// ============================================================================
// 便捷导出：年付总价（美分）
// ============================================================================

/** 各计划年付总价（美分）= annualMonthlyPriceCents × 12 */
export const ANNUAL_TOTAL_PRICE_CENTS: Readonly<Record<PlanKey, number>> = {
  FREE: 0,
  STARTER: 349 * 12,   // 4188
  GROWTH: 699 * 12,    // 8388
  PRO: 1049 * 12,      // 12588
  MAX: 1749 * 12,      // 20988
} as const;

// ============================================================================
// 便捷导出：月付价格显示
// ============================================================================

/** 格式化美分价格为显示字符串，如 "$4.99" */
export function formatPriceCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
