/**
 * File: server/shopify/offline-admin.server.ts
 * Purpose: 后台任务 / 服务端模块的 Offline Admin 凭证统一收口。
 *
 * 以 Session 表为唯一数据源（Single Source of Truth），通过 Shopify 官方
 * `unauthenticated.admin(shop)` 完成：读取 Session → 临期自动 Refresh → 回写 DB。
 * 禁止再从 shops 表解密 accessToken 缓存。
 */
import type { Session } from "@shopify/shopify-api";
import prisma from "../db/prisma.server";

export interface OfflineAdminSessionContext {
  /** 店铺内部 ID */
  shopId: string;
  /** 店铺域名（myshopify.com） */
  shopDomain: string;
  /** 已通过官方链路校验/续期的 Offline Session */
  session: Session;
}

/**
 * 按店铺域名获取 Offline Admin 上下文（含自动 token 续期）。
 *
 * @param shopDomain 店铺域名，如 `example.myshopify.com`
 */
export async function getOfflineAdminByDomain(shopDomain: string): Promise<{
  session: Session;
  shopDomain: string;
}> {
  const { unauthenticated } = await import("../../app/shopify.server");
  const { session } = await unauthenticated.admin(shopDomain);

  if (!session.accessToken) {
    throw new Error(
      `[offline-admin] Offline session missing accessToken for shop: ${shopDomain}`,
    );
  }

  return { session, shopDomain: session.shop };
}

/**
 * 按店铺内部 ID 获取 Offline Admin 上下文（含自动 token 续期）。
 *
 * @param shopId shops 表主键
 */
export async function getOfflineAdminByShopId(
  shopId: string,
): Promise<OfflineAdminSessionContext> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      shopDomain: true,
      uninstalledAt: true,
    },
  });

  if (!shop) {
    throw new Error(`[offline-admin] Shop not found: ${shopId}`);
  }

  if (shop.uninstalledAt) {
    throw new Error(
      `[offline-admin] Shop is uninstalled: ${shopId} (${shop.shopDomain})`,
    );
  }

  const { session } = await getOfflineAdminByDomain(shop.shopDomain);

  return {
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    session,
  };
}

/**
 * 按店铺内部 ID 获取 Admin GraphQL 所需的 domain + accessToken。
 * 适用于仍以原始 token header 发起请求的遗留调用点。
 */
export async function getOfflineAccessTokenByShopId(shopId: string): Promise<{
  shopDomain: string;
  accessToken: string;
}> {
  const { shopDomain, session } = await getOfflineAdminByShopId(shopId);

  // getOfflineAdminByDomain 已校验 accessToken 非空
  return {
    shopDomain,
    accessToken: session.accessToken as string,
  };
}

/**
 * 按店铺域名获取 accessToken（含自动续期）。
 */
export async function getOfflineAccessTokenByDomain(
  shopDomain: string,
): Promise<string> {
  const { session } = await getOfflineAdminByDomain(shopDomain);
  return session.accessToken as string;
}
