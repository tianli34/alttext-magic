/**
 * File: server/modules/billing/billing.types.ts
 * Purpose: 计费系统核心类型定义，与 Prisma 枚举 BillingPlanCode / BillingInterval / CreditBucketType 保持对齐
 */

// ---------------------------------------------------------------------------
// 计划标识 — 与 Prisma BillingPlanCode 枚举对齐
// ---------------------------------------------------------------------------

/** 五档计划唯一标识 */
export type PlanKey = 'FREE' | 'STARTER' | 'GROWTH' | 'PRO' | 'MAX';

/** 所有 PlanKey 的只读列表，用于运行时校验 */
export const PLAN_KEYS: readonly PlanKey[] = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'MAX'] as const;

// ---------------------------------------------------------------------------
// 计费周期 — 与 Prisma BillingInterval 枚举对齐（不含 NONE）
// ---------------------------------------------------------------------------

/** 付费计划的计费周期 */
export type BillingInterval = 'MONTHLY' | 'ANNUAL';

/** 所有 BillingInterval 的只读列表 */
export const BILLING_INTERVALS: readonly BillingInterval[] = ['MONTHLY', 'ANNUAL'] as const;

// ---------------------------------------------------------------------------
// 额度桶类型 — 与 Prisma CreditBucketType 枚举对齐
// ---------------------------------------------------------------------------

export type CreditBucketType =
  | 'FREE_MONTHLY_INCLUDED'
  | 'MONTHLY_INCLUDED'
  | 'ANNUAL_INCLUDED'
  | 'WELCOME'
  | 'OVERAGE_PACK';

// ---------------------------------------------------------------------------
// 超额包配置
// ---------------------------------------------------------------------------

/** 单个超额包规格 */
export interface OveragePackConfig {
  /** 包内额度数量 */
  credits: number;
  /** 价格（美分） */
  priceCents: number;
  /** 显示用价格（如 "$2.99"） */
  displayPrice: string;
  /** 唯一编码，用于 packCode 字段 */
  packCode: string;
}

// ---------------------------------------------------------------------------
// 欢迎额度配置
// ---------------------------------------------------------------------------

/** 安装欢迎额度 */
export interface InstallWelcomeConfig {
  /** 安装赠送额度数量 */
  credits: number;
  /** cycle_key 后缀标识 */
  cycleKeyTag: string;
}

/** 首次付费欢迎额度（按计划分级） */
export interface PaidWelcomeConfig {
  /** 赠送额度数量 */
  credits: number;
  /** cycle_key 后缀标识 */
  cycleKeyTag: string;
}

// ---------------------------------------------------------------------------
// 计划配置主体
// ---------------------------------------------------------------------------

/** 单个计划的完整配置 */
export interface PlanConfig {
  /** 计划标识 */
  planKey: PlanKey;

  /** 显示名称 */
  displayName: string;

  /** 月付价格（美分），FREE 为 0 */
  monthlyPriceCents: number;

  /** 年付折算月价（美分），FREE 为 0 */
  annualMonthlyPriceCents: number;

  /** 月配额额度数 */
  monthlyQuota: number;

  /** 年付一次性发放总量 = 12 × monthlyQuota */
  annualTotalCredits: number;

  /** 是否启用自动增量扫描 */
  incrementalScanEnabled: boolean;

  /** 该计划可选的超额包列表 */
  overagePacks: readonly OveragePackConfig[];

  /** 首次付费欢迎额度（仅付费计划） */
  paidWelcome?: PaidWelcomeConfig;
}
