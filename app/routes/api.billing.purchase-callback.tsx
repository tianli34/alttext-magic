/**
 * File: app/routes/api.billing.purchase-callback.tsx
 * Purpose: GET /api/billing/purchase-callback —— 超额包购买确认回调。
 *          用户在 Shopify 确认一次性支付后，Shopify 将用户重定向至此 URL。
 *          本路由调用超额包发放服务，完成额度桶创建与 GRANT ledger 写入。
 *
 * ### 流程
 * 1. 校验 returnUrl 带回的 shop 与 host，并以 DB 中的 Shop 记录确定店铺
 *    （顶层文档请求无会话令牌，不能使用 authenticate.admin）
 * 2. 从 URL query params 提取 purchaseId
 * 3. 调用 fulfillOveragePackPurchase 发放超额包额度（幂等）
 * 4. 重定向到计费页面（携带发放结果参数）
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createLogger } from "../../server/utils/logger";
import { fulfillOveragePackPurchase } from "../../server/modules/billing/overage-pack.service";
import { env } from "../../server/config/env";

const logger = createLogger({ module: "api.billing.purchase-callback" });

function buildBillingRedirectUrl(requestUrl: URL, params: Record<string, string>): string {
  const searchParams = new URLSearchParams(requestUrl.search);
  Object.entries(params).forEach(([key, value]) => {
    searchParams.set(key, value);
  });

  return `/app/billing?${searchParams.toString()}`;
}

// ============================================================================
// Loader（GET 请求）
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 识别店铺 —— 本路由由 Shopify 确认页以顶层文档请求跳入，没有会话令牌，
  //    只能校验 returnUrl 带回的 shop，并以 DB 中的 Shop 记录为唯一可信来源。
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const hostParam = url.searchParams.get("host");

  if (!shopParam || !hostParam) {
    return Response.json(
      { error: "Missing shop or host parameter" },
      { status: 400 },
    );
  }

  const shopRecord = await prisma.shop.findUnique({
    where: { shopDomain: shopParam },
    select: { shopDomain: true },
  });

  if (!shopRecord) {
    logger.warn({ shopParam }, "purchase callback 携带未知 shop");
    return Response.json({ error: "Unknown shop" }, { status: 404 });
  }

  const shopDomain = shopRecord.shopDomain;
  const purchaseId = url.searchParams.get("purchaseId");

  logger.info(
    { shopDomain, purchaseId },
    "收到 purchase callback",
  );

  // 2. 校验 purchaseId 参数
  if (!purchaseId) {
    logger.warn({ shopDomain }, "purchase callback 缺少 purchaseId 参数");
    const billingUrl = buildBillingRedirectUrl(url, { pack: "missing" });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
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
    //    - success: 本次完成发放
    //    - already-granted: 幂等跳过（此前已发放）
    //    - pending: 回查发现 Shopify 侧购买尚未 ACTIVE，未发放
    let packParam: string;
    if (result.fulfilled) {
      packParam = "success";
    } else if (result.reason) {
      packParam = "pending";
    } else {
      packParam = "already-granted";
    }

    const billingUrl = buildBillingRedirectUrl(url, { pack: packParam });

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
    const billingUrl = buildBillingRedirectUrl(url, { pack: "failed" });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  }
};
