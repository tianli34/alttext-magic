/**
 * File: app/routes/api.settings.scopes.tsx
 * Purpose: PUT /api/settings/scopes —— 更新 shop 的 scan_scope_flags。
 *          接收 { products, files, collections, articles } 友好名称，
 *          映射为内部 { PRODUCT_MEDIA, FILES, COLLECTION_IMAGE, ARTICLE_IMAGE }。
 *          仅更新 scan_scope_flags，绝不触发扫描、绝不修改 last_published_scope_flags。
 *
 * 请求体: { products: boolean, files: boolean, collections: boolean, articles: boolean }
 * 响应体: ScopeSettings（scanScopeFlags / lastPublishedScopeFlags / effectiveReadScopeFlags）
 */
import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { updateScanScopeFlags } from "../../server/modules/shop/scope.service";
import { createLogger } from "../../server/utils/logger";
import type { ScopeFlagState } from "../lib/scope-utils";

const logger = createLogger({ module: "api.settings.scopes" });

const FRIENDLY_TO_INTERNAL: Record<string, keyof ScopeFlagState> = {
  products: "PRODUCT_MEDIA",
  files: "FILES",
  collections: "COLLECTION_IMAGE",
  articles: "ARTICLE_IMAGE",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "PUT") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for scopes update");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const internalFlags: Record<string, boolean> = {};
  for (const [friendly, internal] of Object.entries(FRIENDLY_TO_INTERNAL)) {
    const val = body[friendly];
    if (typeof val !== "boolean") {
      return Response.json(
        { error: `Invalid or missing field: ${friendly} (expected boolean)` },
        { status: 400 },
      );
    }
    internalFlags[internal] = val;
  }

  try {
    const result = await updateScanScopeFlags(shop.id, internalFlags);
    logger.info({ shopId: shop.id }, "Scope flags updated via settings");
    return Response.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      logger.warn({ shopId: shop.id, issues }, "Invalid scope flags");
      return Response.json({ error: "Invalid flags", issues }, { status: 400 });
    }
    logger.error({ shopId: shop.id, err }, "Failed to update scope flags");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
};
