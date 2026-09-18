/**
 * File: app/routes/api.billing.purchase-pack.tsx
 * Purpose: POST /api/billing/purchase-pack —— 超额包购买接口。
 *          校验当前计划与超额包配置，调用 Shopify Billing API 创建一次性购买，
 *          返回确认支付跳转 URL。
 *
 * 请求体: { packCode: string, host?: string }
 * 响应体: { confirmationUrl: string }
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createLogger } from "../../server/utils/logger";
import { getPlanConfig } from "../../server/modules/billing/plan-config";
import { getBillingAdapter } from "../../server/shopify/billing-adapter";
import { initiateOveragePackPurchase } from "../../server/modules/billing/overage-pack.service";
import { env } from "../../server/config/env";
import type { PlanKey } from "../../server/modules/billing/billing.types";

const logger = createLogger({ module: "api.billing.purchase-pack" });

// ============================================================================
// 请求体 Schema
// ============================================================================

const purchasePackBodySchema = z.object({
  packCode: z.string().min(1, "packCode is required"),
  // 嵌入式 iframe URL 上的 host，回调返回 App 时用于重新嵌入（空串按缺失处理）
  host: z.string().optional(),
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

  // 3. 查找 shop
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      shopDomain: true,
      currentPlan: true,
    },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for purchase-pack");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof purchasePackBodySchema>;
  try {
    parsed = purchasePackBodySchema.parse(body);
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

  const { packCode, host } = parsed;
  const currentPlan = shop.currentPlan as PlanKey;

  // 5. 校验 packCode 对应当前计划的超额包配置
  const planConfig = getPlanConfig(currentPlan);
  const packConfig = planConfig.overagePacks.find((p) => p.packCode === packCode);
  if (!packConfig) {
    return Response.json(
      {
        error: `Invalid packCode: ${packCode} for plan ${currentPlan}. Available: ${planConfig.overagePacks.map((p) => p.packCode).join(", ")}`,
      },
      { status: 400 },
    );
  }

  // 6. 构造回调 URL
  //    Shopify 确认页会以顶层文档请求把用户送回此地址，届时没有会话令牌，
  //    purchase-callback 只能靠 shop + host 查询参数识别店铺并重新嵌入 App。
  const returnUrl = new URL(`${env.SHOPIFY_APP_URL}/api/billing/purchase-callback`);
  returnUrl.searchParams.set("shop", shop.shopDomain);
  if (host) {
    returnUrl.searchParams.set("host", host);
  }

  const adapter = getBillingAdapter();

  try {
    // 7. 发起超额包购买
    const result = await initiateOveragePackPurchase(
      {
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        currentPlan,
        packCode,
        returnUrl: returnUrl.toString(),
      },
      adapter,
      prisma,
    );

    logger.info(
      { shopId: shop.id, packCode, purchaseId: result.purchaseId },
      "超额包购买已发起",
    );

    return Response.json({ confirmationUrl: result.confirmationUrl });
  } catch (err) {
    logger.error(
      { shopId: shop.id, packCode, err },
      "超额包购买发起失败",
    );
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
