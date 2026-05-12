/**
 * File: server/modules/billing/plan-config.ts
 * Purpose: 计费计划查询 helper 函数集，提供统一的计划配置访问接口。
 *          所有查询均基于 server/config/plans.ts 的常量配置。
 */

import { BILLING_INTERVALS, PLAN_KEYS, type BillingInterval, type PlanKey } from './billing.types';
import type { PlanConfig } from './billing.types';
import { INSTALL_WELCOME, PAID_WELCOME_MAP, PLAN_CONFIGS } from '../../config/plans';

// ============================================================================
// 基础查询
// ============================================================================

/**
 * 获取指定计划的完整配置。
 * 若 planKey 不合法则抛出异常。
 */
export function getPlanConfig(planKey: PlanKey): PlanConfig {
  const config = PLAN_CONFIGS[planKey];
  if (!config) {
    throw new Error(`[plan-config] 未知的计划标识: ${planKey}`);
  }
  return config;
}

// ============================================================================
// 额度计算
// ============================================================================

/**
 * 获取指定计划在给定计费周期下的 included 额度数。
 * - 月付：返回 monthlyQuota
 * - 年付：返回 annualTotalCredits（= 12 × monthlyQuota）
 * - FREE 计划固定返回 monthlyQuota（25），忽略 interval 参数
 */
export function getIncludedCredits(planKey: PlanKey, interval: BillingInterval): number {
  const config = getPlanConfig(planKey);

  if (planKey === 'FREE') {
    return config.monthlyQuota;
  }

  return interval === 'ANNUAL' ? config.annualTotalCredits : config.monthlyQuota;
}

/**
 * 获取指定计划年付一次性发放总量。
 * 便捷方法，等价于 getIncludedCredits(planKey, 'ANNUAL')。
 * FREE 返回 0。
 */
export function getAnnualIncludedCredits(planKey: PlanKey): number {
  return getIncludedCredits(planKey, 'ANNUAL');
}

// ============================================================================
// cycle_key 生成
// ============================================================================

/**
 * 生成付费计划的月/年 cycle_key。
 * - 月付：`INCLUDED:{planKey}:YYYY-MM`
 * - 年付：`INCLUDED:{planKey}:YYYY`
 *
 * @param date   周期锚点日期（用于提取年/月）
 * @param planKey 计划标识
 * @param interval 计费周期
 */
export function getMonthlyCycleKey(date: Date, planKey: PlanKey, interval: BillingInterval): string {
  if (interval === 'ANNUAL') {
    const year = date.getUTCFullYear();
    return `INCLUDED:${planKey}:${year}`;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `INCLUDED:${planKey}:${year}-${month}`;
}

/**
 * 生成 Free 月配额的 cycle_key。
 * 格式：`FREE:YYYY-MM`（与规格文档 §4.9.2 一致）
 */
export function getFreeCycleKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `FREE:${year}-${month}`;
}

/**
 * 获取首次付费欢迎额度的 cycle_key。
 * 格式：`{PaidWelcomeConfig.cycleKeyTag}`（仅一次，不含日期）
 */
export function getPaidWelcomeCycleKey(planKey: PlanKey): string {
  if (planKey === 'FREE') {
    throw new Error('[plan-config] FREE 计划无付费欢迎额度');
  }
  const welcome = PAID_WELCOME_MAP[planKey];
  if (!welcome) {
    throw new Error(`[plan-config] 计划 ${planKey} 无付费欢迎额度配置`);
  }
  return welcome.cycleKeyTag;
}

/**
 * 获取安装欢迎额度的 cycle_key。
 * 格式：`INSTALL_WELCOME`（仅一次，全局唯一）
 */
export function getInstallWelcomeCycleKey(): string {
  return INSTALL_WELCOME.cycleKeyTag;
}

// ============================================================================
// 布尔判断
// ============================================================================

/** 判断是否为付费计划（非 FREE） */
export function isPaidPlan(planKey: PlanKey): boolean {
  return planKey !== 'FREE';
}

/** 判断指定计划是否可以购买超额包（所有计划均可购买） */
export function canPurchaseOveragePack(planKey: PlanKey): boolean {
  const config = getPlanConfig(planKey);
  return config.overagePacks.length > 0;
}

// ============================================================================
// 欢迎额度查询
// ============================================================================

/** 获取安装欢迎额度数量 */
export function getInstallWelcomeCredits(): number {
  return INSTALL_WELCOME.credits;
}

/**
 * 获取首次付费欢迎额度数量。
 * FREE 返回 0。
 */
export function getPaidWelcomeCredits(planKey: PlanKey): number {
  if (planKey === 'FREE') {
    return 0;
  }
  return PAID_WELCOME_MAP[planKey].credits;
}

// ============================================================================
// 运行时校验
// ============================================================================

/** 判断给定值是否为合法的 PlanKey */
export function isValidPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

/** 判断给定值是否为合法的 BillingInterval（不含 NONE） */
export function isValidBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}
