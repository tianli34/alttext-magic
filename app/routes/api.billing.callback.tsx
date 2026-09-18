/**
 * File: app/routes/api.billing.callback.tsx
 * Purpose: GET /api/billing/callback —— Shopify 订阅确认回调。
 *          用户在 Shopify 确认支付后，Shopify 将用户重定向至此 URL。
 *          本路由调用统一的订阅同步服务，将 Shopify 侧订阅状态同步到本地。
 *
 * ### 流程
 * 1. 校验 returnUrl 带回的 shop 与 host，并以 DB 中的 Shop 记录确定店铺
 *    （顶层文档请求无会话令牌，不能使用 authenticate.admin）
 * 2. 调用 syncSubscriptionFromShopify 统一同步服务
 * 3. 同步发现变更时调用 applySubscriptionChangeFromSync 立即发放额度/作废旧桶
 * 4. 重定向到计费页面（携带同步结果参数）
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createLogger } from "../../server/utils/logger";
import { syncSubscriptionFromShopify } from "../../server/modules/billing/subscription.service";
import { applySubscriptionChangeFromSync } from "../../server/modules/billing/apply-subscription-change.server";
import { env } from "../../server/config/env";

const logger = createLogger({ module: "api.billing.callback" });

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
    logger.warn({ shopParam }, "billing callback 携带未知 shop");
    return Response.json({ error: "Unknown shop" }, { status: 404 });
  }

  const shopDomain = shopRecord.shopDomain;

  logger.info(
    {
      shopDomain,
      searchParams: Object.fromEntries(url.searchParams.entries()),
    },
    "收到 billing callback",
  );

  try {
    // 2. 调用统一的订阅同步服务
    const result = await syncSubscriptionFromShopify(shopDomain);

    logger.info(
      {
        shopDomain,
        created: result.created,
        changed: result.changed,
        planCode: result.planCode,
        status: result.status,
      },
      "订阅同步完成",
    );

    // 2b. 发现变更 → 立即执行额度发放/旧桶作废，
    //     确保用户回到 Billing 页时剩余额度已反映新计划。
    //     （函数内部含 changed/status 守卫，失败不抛出，由 billing-sync 定时任务兜底）
    const applied = await applySubscriptionChangeFromSync(result);

    logger.info(
      { shopDomain, changed: result.changed, applied },
      "订阅变更额度发放处理完成",
    );

    // 3. 重定向到计费页面（嵌入式应用需要通过 App Bridge 重定向）
    const billingUrl = buildBillingRedirectUrl(url, {
      sync: "success",
      plan: result.planCode,
      changed: String(result.changed),
    });

    // 如果是 Shopify 嵌入式应用，需要返回 HTML 使用 redirect
    // 对于嵌入式应用，直接返回 302 重定向到 app tunnel
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  } catch (error) {
    logger.error(
      { shopDomain, err: error },
      "订阅同步失败",
    );

    // 同步失败时仍重定向到计费页面，但标记失败
    const billingUrl = buildBillingRedirectUrl(url, { sync: "failed" });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  }
};
