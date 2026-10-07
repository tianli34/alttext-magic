/**
 * File: server/modules/billing/included-cycle-key.ts
 * Purpose: 付费计划 included 额度桶 cycleKey 生成规则的唯一权威来源。
 *          订阅变更发放（apply-subscription-change）与周期性续发（paid-included-grant）
 *          必须共享同一套格式，才能借助 (shopId, bucketType, cycleKey) 唯一约束实现幂等。
 *
 * ### 格式约定（与已存线上数据保持兼容，不可随意变更）
 * - 月付：`{planKey}:MONTHLY:YYYY-MM`
 * - 年付（订阅变更首发）：`{planKey}:ANNUAL:{shopifySubscriptionId}`
 * - 年付（年度续发）：`{planKey}:ANNUAL:{shopifySubscriptionId}:{YYYY}`
 *
 * 年付首发与续发格式不同：Shopify 年付续订通常保持同一订阅 GID，
 * 若续发沿用首发格式会命中唯一约束导致新年度额度永远无法发放，
 * 故续发在尾部追加年份以区分。
 */

import type { PlanKey } from './billing.types';

/**
 * 生成月付计划的 included bucket cycleKey。
 * 格式：`{planKey}:MONTHLY:YYYY-MM`
 * 示例：`STARTER:MONTHLY:2026-05`
 */
export function generateMonthlyIncludedCycleKey(
  planKey: PlanKey,
  date: Date,
): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${planKey}:MONTHLY:${year}-${month}`;
}

/**
 * 生成年付计划的 included bucket cycleKey（订阅变更首发用）。
 * 格式：`{planKey}:ANNUAL:{shopifySubscriptionId}`
 * 示例：`GROWTH:ANNUAL:gid://shopify/AppSubscription/1234567`
 */
export function generateAnnualIncludedCycleKey(
  planKey: PlanKey,
  externalSubscriptionId: string,
): string {
  return `${planKey}:ANNUAL:${externalSubscriptionId}`;
}

/**
 * 生成年付计划的年度续发 cycleKey。
 * 格式：`{planKey}:ANNUAL:{shopifySubscriptionId}:{YYYY}`
 * 示例：`GROWTH:ANNUAL:gid://shopify/AppSubscription/1234567:2027`
 */
export function generateAnnualRenewalCycleKey(
  planKey: PlanKey,
  externalSubscriptionId: string,
  year: number,
): string {
  return `${planKey}:ANNUAL:${externalSubscriptionId}:${year}`;
}
