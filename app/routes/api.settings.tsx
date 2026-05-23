/**
 * GET /api/settings —— 返回 Settings 页面所需聚合数据。
 *
 * 响应体:
 * {
 *   scopes:  {
 *     scanScopeFlags, lastPublishedScopeFlags, effectiveReadScopeFlags
 *   },
 *   plan:    { planKey, displayName, monthlyQuota, incrementalScanEnabled },
 *   helpLinks: { faq, contact, docs }
 * }
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getScopeSettings } from "../../server/modules/shop/scope.service";
import { getPlanConfig } from "../../server/modules/billing/plan-config";
import { createLogger } from "../../server/utils/logger";
import type { PlanKey } from "../../server/modules/billing/billing.types";

const logger = createLogger({ module: "api.settings" });

interface HelpLinks {
  faq: string;
  contact: string;
  docs: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true, currentPlan: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for settings");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const shopId = shop.id;

  const [scopes, subscription] = await Promise.all([
    getScopeSettings(shopId),
    prisma.billingSubscription.findFirst({
      where: { shopId, status: "ACTIVE" },
      select: { planCode: true, incrementalScanEnabled: true },
    }),
  ]);

  const currentPlan = (subscription?.planCode ?? shop.currentPlan ?? "FREE") as PlanKey;
  const planConfig = getPlanConfig(currentPlan);

  const helpLinks: HelpLinks = {
    faq: process.env.SETTINGS_HELP_FAQ_URL || "https://help.example.com/faq",
    contact: process.env.SETTINGS_HELP_CONTACT_URL || "https://help.example.com/contact",
    docs: process.env.SETTINGS_HELP_DOCS_URL || "https://help.example.com/docs",
  };

  logger.info({ shopId, currentPlan }, "Settings data loaded");

  return Response.json({
    scopes,
    plan: {
      planKey: currentPlan,
      displayName: planConfig.displayName,
      monthlyQuota: planConfig.monthlyQuota,
      incrementalScanEnabled: planConfig.incrementalScanEnabled,
    },
    helpLinks,
  });
};
