/**
 * File: app/routes/api.billing.callback.tsx
 * Purpose: GET /api/billing/callback —— Shopify 订阅确认回调。
 *          用户在 Shopify 确认支付后，Shopify 将用户重定向至此 URL。
 *          本路由调用统一的订阅同步服务，将 Shopify 侧订阅状态同步到本地。
 *
 * ### 流程
 * 1. 通过 authenticate.admin 识别当前 shop
 * 2. 调用 syncSubscriptionFromShopify 统一同步服务
 * 3. 重定向到计费页面（携带同步结果参数）
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createLogger } from "../../server/utils/logger";
import { syncSubscriptionFromShopify } from "../../server/modules/billing/subscription.service";
import { env } from "../../server/config/env";

const logger = createLogger({ module: "api.billing.callback" });

// ============================================================================
// Loader（GET 请求）
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 鉴权 —— 确保 Shopify 登录态
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const url = new URL(request.url);
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

    // 3. 重定向到计费页面（嵌入式应用需要通过 App Bridge 重定向）
    const billingUrl = `/app/billing?sync=success&plan=${result.planCode}&changed=${result.changed}`;

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
    const billingUrl = `/app/billing?sync=failed`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.SHOPIFY_APP_URL}${billingUrl}`,
      },
    });
  }
};
