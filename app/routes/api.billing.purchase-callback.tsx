/**
 * File: app/routes/api.billing.purchase-callback.tsx
 * Purpose: GET /api/billing/purchase-callback —— 超额包购买确认回调。
 *          用户在 Shopify 确认一次性支付后，Shopify 将用户重定向至此 URL。
 *          本路由调用超额包发放服务，完成额度桶创建与 GRANT ledger 写入。
 *
 * ### 流程
 * 1. 通过 authenticate.admin 识别当前 shop
 * 2. 从 URL query params 提取 purchaseId
 * 3. 调用 fulfillOveragePackPurchase 发放超额包额度（幂等）
 * 4. 重定向到计费页面（携带发放结果参数）
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createLogger } from "../../server/utils/logger";
import { fulfillOveragePackPurchase } from "../../server/modules/billing/overage-pack.service";
import { env } from "../../server/config/env";

const logger = createLogger({ module: "api.billing.purchase-callback" });

// ============================================================================
// Loader（GET 请求）
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 鉴权 —— 确保 Shopify 登录态
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const purchaseId = url.searchParams.get("purchaseId");

  logger.info(
    { shopDomain, purchaseId },
    "收到 purchase callback",
  );

  // 2. 校验 purchaseId 参数
  if (!purchaseId) {
    logger.warn({ shopDomain }, "purchase callback 缺少 purchaseId 参数");
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}/app/billing?pack=missing`,
      },
    });
  }

  try {
    // 3. 调用超额包发放服务（幂等）
    const result = await fulfillOveragePackPurchase(purchaseId, prisma);

    logger.info(
      { shopDomain, purchaseId, fulfilled: result.fulfilled },
      "超额包发放完成",
    );

    // 4. 重定向到计费页面
    const packParam = result.fulfilled ? "success" : "already-granted";
    const billingUrl = `/app/billing?pack=${packParam}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  } catch (error) {
    logger.error(
      { shopDomain, purchaseId, err: error },
      "超额包发放失败",
    );

    // 发放失败时仍重定向到计费页面，但标记失败
    const billingUrl = `/app/billing?pack=failed`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  }
};
