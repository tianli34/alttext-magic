/**
 * File: server/modules/billing/billing.types.ts
 * Purpose: 计费系统核心类型定义，与 Prisma 枚举 BillingPlanCode / BillingInterval / CreditBucketType 保持对齐
 */
/** 所有 PlanKey 的只读列表，用于运行时校验 */
export const PLAN_KEYS = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'MAX'];
/** 所有 BillingInterval 的只读列表 */
export const BILLING_INTERVALS = ['MONTHLY', 'ANNUAL'];
