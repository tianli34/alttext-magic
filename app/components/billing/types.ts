/**
 * File: app/components/billing/types.ts
 * Purpose: Billing 页面前端共享类型定义，与 api.billing.summary 的 BillingSummaryResponse 对齐。
 */

/** 计划标识 */
export type PlanKey = 'FREE' | 'STARTER' | 'GROWTH' | 'PRO' | 'MAX';

/** 计费周期 */
export type BillingInterval = 'MONTHLY' | 'ANNUAL';

/** 单条购买记录 */
export interface RecentPurchase {
  packKey: string;
  amount: number;
  price: number;
  currency: string;
  createdAt: string;
}

/** 超额包摘要 */
export interface OveragePackSummary {
  packCode: string;
  credits: number;
  priceCents: number;
  displayPrice: string;
}

/** 计划配置摘要 */
export interface PlanSummary {
  planKey: PlanKey;
  displayName: string;
  monthlyPriceCents: number;
  annualMonthlyPriceCents: number;
  monthlyQuota: number;
  annualTotalCredits: number;
  incrementalScanEnabled: boolean;
}

/** GET /api/billing/summary 响应体 */
export interface BillingSummaryResponse {
  currentPlan: PlanKey;
  billingInterval: BillingInterval;
  incrementalScanEnabled: boolean;
  includedRemaining: number;
  includedPeriodType: string;
  welcomeRemaining: number;
  overagePackRemaining: number;
  totalRemaining: number;
  recentPurchases: RecentPurchase[];
  plans: PlanSummary[];
  overagePacks: OveragePackSummary[];
}

/** POST /api/billing/change-plan 响应体 */
export interface ChangePlanResponse {
  confirmationUrl?: string;
  success?: boolean;
  cancelledSubscription?: boolean;
  error?: string;
}

/** POST /api/billing/purchase-pack 响应体 */
export interface PurchasePackResponse {
  confirmationUrl?: string;
  error?: string;
}
