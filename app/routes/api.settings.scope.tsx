/**
 * File: app/routes/api.settings.scope.tsx
 * Purpose: POST /api/settings/scope —— 更新 shop 的 scan_scope_flags。
 *          仅修改 scan_scope_flags 和 scan_scope_updated_at，
 *          绝不修改 last_published_scope_flags。
 *
 * 请求体: { flags: ScopeFlagState }
 * 响应体: ScopeSettings（scanScopeFlags / lastPublishedScopeFlags / effectiveReadScopeFlags）
 */
import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { updateScanScopeFlags } from "../../server/modules/shop/scope.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.settings.scope" });

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. 仅接受 POST
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 2. 鉴权 —— 确保 Shopify 登录态
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 3. 通过 shopDomain 查找内部 shopId
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for scope update");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 5. 提取 flags 字段
  const flags = (body as Record<string, unknown>).flags;
  if (flags === undefined || flags === null) {
    return Response.json(
      { error: "Missing required field: flags" },
      { status: 400 },
    );
  }

  // 6. 调用服务层更新 —— 内部 Zod 校验，非法 flag 抛 ZodError
  try {
    const result = await updateScanScopeFlags(shop.id, flags);

    logger.info({ shopId: shop.id }, "Scope flags updated successfully");

    return Response.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      // 非法 flag → 400
      const issues = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      logger.warn({ shopId: shop.id, issues }, "Invalid scope flags");
      return Response.json({ error: "Invalid flags", issues }, { status: 400 });
    }

    // 其他未知错误 → 500
    logger.error({ shopId: shop.id, err }, "Failed to update scope flags");
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
