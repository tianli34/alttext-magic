/**
 * File: app/routes/api.billing.summary.tsx
 * Purpose: GET /api/billing/summary —— 为 Billing 页面和 Dashboard 提供统一计费摘要。
 *
 * ### 返回数据
 * - 当前计划、计费周期、增量扫描开关
 * - 分组余额（included / welcome / overage pack）
 * - 最近超额包购买记录
 * - 所有计划配置（供前端展示定价表）
 * - 当前计划的超额包配置
 *
 * ### 兜底逻辑
 * - 新安装店铺若缺少 billing_subscription，使用 shop.currentPlan（默认 FREE）
 * - billingInterval 为 NONE 时（Free 计划），前端展示为 MONTHLY
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { createLogger } from "../../server/utils/logger";
import { getCreditBalance } from "../../server/modules/billing/credit/credit-balance.server";
import { getPlanConfig } from "../../server/modules/billing/plan-config";
import { PLAN_CONFIGS } from "../../server/config/plans";
import type { PlanKey, BillingInterval } from "../../server/modules/billing/billing.types";

const logger = createLogger({ module: "api.billing.summary" });

// ============================================================================
// 响应类型
// ============================================================================

/** 单条最近购买记录 */
interface RecentPurchase {
  packKey: string;
  amount: number;
  price: number;
  currency: string;
  createdAt: string;
}

/** 超额包配置（前端展示用） */
interface OveragePackSummary {
  packCode: string;
  credits: number;
  priceCents: number;
  displayPrice: string;
}

/** 计划配置摘要（前端展示用） */
interface PlanSummary {
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

// ============================================================================
// Loader（GET 请求）
// ============================================================================

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<Response> => {
  // ---- 1. 鉴权 ----
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // ---- 2. 查找 shop ----
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true, currentPlan: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for billing summary");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const shopId = shop.id;

  // ---- 3. 查询活跃订阅 ----
  const subscription = await prisma.billingSubscription.findFirst({
    where: { shopId, status: "ACTIVE" },
    select: {
      planCode: true,
      billingInterval: true,
      incrementalScanEnabled: true,
    },
  });

  // ---- 4. 确定当前计划信息 ----
  // 兜底：无活跃订阅时使用 shop.currentPlan（默认 FREE）
  const currentPlan = (subscription?.planCode ?? shop.currentPlan ?? "FREE") as PlanKey;
  const rawInterval = subscription?.billingInterval ?? "NONE";
  // Free 计划 interval 为 NONE，前端统一视为 MONTHLY
  const billingInterval: BillingInterval =
    rawInterval === "ANNUAL" ? "ANNUAL" : "MONTHLY";
  const incrementalScanEnabled = subscription?.incrementalScanEnabled ?? false;

  logger.debug(
    { shopId, currentPlan, billingInterval, incrementalScanEnabled },
    "计费摘要查询参数",
  );

  // ---- 5. 调用余额服务 ----
  const balance = await getCreditBalance(shopId);

  // ---- 6. 查询最近超额包购买记录 ----
  const recentPurchases = await prisma.overagePackPurchase.findMany({
    where: {
      shopId,
      status: "PURCHASED",
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      packCode: true,
      grantedAmount: true,
      priceCents: true,
      currencyCode: true,
      createdAt: true,
    },
  });

  // ---- 7. 获取当前计划的超额包配置 ----
  const planConfig = getPlanConfig(currentPlan);
  const overagePacks: OveragePackSummary[] = planConfig.overagePacks.map(
    (pack) => ({
      packCode: pack.packCode,
      credits: pack.credits,
      priceCents: pack.priceCents,
      displayPrice: pack.displayPrice,
    }),
  );

  // ---- 8. 获取所有计划配置 ----
  const plans: PlanSummary[] = Object.values(PLAN_CONFIGS).map((config) => ({
    planKey: config.planKey,
    displayName: config.displayName,
    monthlyPriceCents: config.monthlyPriceCents,
    annualMonthlyPriceCents: config.annualMonthlyPriceCents,
    monthlyQuota: config.monthlyQuota,
    annualTotalCredits: config.annualTotalCredits,
    incrementalScanEnabled: config.incrementalScanEnabled,
  }));

  // ---- 9. 组装响应 ----
  const response: BillingSummaryResponse = {
    currentPlan,
    billingInterval,
    incrementalScanEnabled,
    includedRemaining: balance.includedRemaining,
    includedPeriodType: balance.includedPeriodType,
    welcomeRemaining: balance.welcomeRemaining,
    overagePackRemaining: balance.overagePackRemaining,
    totalRemaining: balance.totalRemaining,
    recentPurchases: recentPurchases.map((p) => ({
      packKey: p.packCode,
      amount: p.grantedAmount,
      price: p.priceCents / 100,
      currency: p.currencyCode,
      createdAt: p.createdAt.toISOString(),
    })),
    plans,
    overagePacks,
  };

  logger.info(
    {
      shopId,
      currentPlan,
      totalRemaining: balance.totalRemaining,
      purchaseCount: recentPurchases.length,
    },
    "计费摘要查询完成",
  );

  return Response.json(response);
};
