/**
 * File: app/routes/api.billing.change-plan.tsx
 * Purpose: POST /api/billing/change-plan —— 计划变更接口。
 *          支持付费计划月付/年付切换，以及降级到 Free。
 *
 * 请求体: { plan: PlanKey, interval: BillingInterval }
 * 响应体:
 *   - 付费计划: { confirmationUrl: string }
 *   - Free 降级: { success: true, cancelledSubscription: boolean }
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createLogger } from "../../server/utils/logger";
import {
  isValidPlanKey,
  isValidBillingInterval,
} from "../../server/modules/billing/plan-config";
import { getBillingAdapter } from "../../server/shopify/billing-adapter";
import {
  changePlanToPaid,
  changePlanToFree,
} from "../../server/modules/billing/plan-change.service";
import { env } from "../../server/config/env";
import type { PlanKey, BillingInterval } from "../../server/modules/billing/billing.types";

const logger = createLogger({ module: "api.billing.change-plan" });

// ============================================================================
// 请求体 Schema
// ============================================================================

const changePlanBodySchema = z.object({
  plan: z.string().min(1, "plan is required"),
  interval: z.string().min(1, "interval is required"),
});

// ============================================================================
// Action
// ============================================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. 仅接受 POST
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 2. 鉴权 —— 确保 Shopify 登录态
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 3. 查找 shop（含加密 token 字段）
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      shopDomain: true,
      accessTokenEncrypted: true,
      accessTokenNonce: true,
      accessTokenTag: true,
      currentPlan: true,
    },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for change-plan");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof changePlanBodySchema>;
  try {
    parsed = changePlanBodySchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return Response.json(
        { error: "Invalid request body", issues },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { plan: rawPlan, interval: rawInterval } = parsed;

  // 5. 校验 plan 合法性
  if (!isValidPlanKey(rawPlan)) {
    return Response.json(
      {
        error: `Unknown plan: ${rawPlan}. Allowed: FREE, STARTER, GROWTH, PRO, MAX`,
      },
      { status: 400 },
    );
  }

  // 6. 校验 interval 合法性
  if (!isValidBillingInterval(rawInterval)) {
    return Response.json(
      {
        error: `Invalid interval: ${rawInterval}. Allowed: MONTHLY, ANNUAL`,
      },
      { status: 400 },
    );
  }

  const planKey: PlanKey = rawPlan;
  const interval: BillingInterval = rawInterval;

  // 7. 构造 returnUrl，指向 billing callback
  const returnUrl = `${env.SHOPIFY_APP_URL}/api/billing/callback`;

  const adapter = getBillingAdapter();

  try {
    if (planKey === "FREE") {
      // ---- Free 降级路径 ----
      // 注意：Free 降级不会创建 Shopify 付费订阅
      const result = await changePlanToFree(
        {
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          accessTokenEncrypted: shop.accessTokenEncrypted,
          accessTokenNonce: shop.accessTokenNonce,
          accessTokenTag: shop.accessTokenTag,
        },
        adapter,
        prisma,
      );

      logger.info(
        { shopId: shop.id, cancelledSubscription: result.cancelledSubscription },
        "降级到 Free 成功",
      );

      return Response.json({
        success: true,
        cancelledSubscription: result.cancelledSubscription,
      });
    }

    // ---- 付费计划升级/切换路径 ----
    const result = await changePlanToPaid(
      {
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        accessTokenEncrypted: shop.accessTokenEncrypted,
        accessTokenNonce: shop.accessTokenNonce,
        accessTokenTag: shop.accessTokenTag,
        planKey,
        interval,
        returnUrl,
      },
      adapter,
    );

    logger.info(
      { shopId: shop.id, planKey, interval },
      "付费计划变更确认链接已创建",
    );

    return Response.json({ confirmationUrl: result.confirmationUrl });
  } catch (err) {
    logger.error(
      { shopId: shop.id, planKey, interval, err },
      "计划变更失败",
    );
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
