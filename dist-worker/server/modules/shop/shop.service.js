/**
 * File: server/modules/shop/shop.service.ts
 * Purpose: Persist the canonical shop installation record after Shopify
 * authentication completes. Offline access token 由 Session 表托管。
 * 计费与额度初始化已迁移至 bootstrapShopBilling 服务。
 */
import { randomUUID } from "node:crypto";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
import { DEFAULT_SCAN_SCOPE_FLAGS } from "./scope.service";
import { executeShopifyGraphql } from "../writeback/mutations/mutation-utils";
import { SHOP_TIMEZONE_QUERY } from "../../shopify/queries/shop.query";
const logger = createLogger({ module: "shop-service" });
const DEFAULT_PLAN = "FREE";
const LEGACY_TOKEN_PLACEHOLDER = "";
function assertOfflineSession(session) {
    if (session.isOnline) {
        throw new Error("Expected an offline Shopify session");
    }
    if (!session.accessToken) {
        throw new Error("Offline Shopify session is missing an access token");
    }
}
/**
 * 持久化店铺安装记录（upsert）。
 * 仅负责 shop 表写入，不再直接创建 credit_bucket。
 * 计费与额度初始化由调用方在 afterAuth 流程中通过 bootstrapShopBilling 完成。
 */
export async function persistOfflineShopSession({ session, }) {
    if (session.isOnline) {
        logger.debug({ shop: session.shop, sessionId: session.id }, "Skipping shop persistence for online session");
        throw new Error("Online session not supported");
    }
    assertOfflineSession(session);
    const installedAt = new Date();
    const serializedScanScopeFlags = JSON.stringify(DEFAULT_SCAN_SCOPE_FLAGS);
    const shopId = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw `
      INSERT INTO "shops" (
        "id",
        "shop_domain",
        "access_token_encrypted",
        "access_token_nonce",
        "access_token_tag",
        "scopes",
        "current_plan",
        "scan_scope_flags",
        "installed_at",
        "uninstalled_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${randomUUID()},
        ${session.shop},
        ${LEGACY_TOKEN_PLACEHOLDER},
        ${LEGACY_TOKEN_PLACEHOLDER},
        ${LEGACY_TOKEN_PLACEHOLDER},
        ${session.scope ?? null},
        ${DEFAULT_PLAN},
        ${serializedScanScopeFlags}::jsonb,
        ${installedAt},
        NULL,
        ${installedAt},
        ${installedAt}
      )
      ON CONFLICT ("shop_domain") DO UPDATE
      SET
        "scopes" = EXCLUDED."scopes",
        "uninstalled_at" = NULL,
        "updated_at" = EXCLUDED."updated_at"
    `;
        const shop = await tx.shop.findUniqueOrThrow({
            where: { shopDomain: session.shop },
            select: { id: true },
        });
        return shop.id;
    });
    logger.info({ shop: session.shop, sessionId: session.id, shopId }, "Persisted shop installation record");
    return { shopId };
}
/**
 * 通过 Shopify Admin API 获取店铺时区并持久化到 shops 表。
 * 安装时调用一次即可，后续如需刷新可单独调用。
 */
export async function fetchAndSaveShopTimezone(session) {
    const shopDomain = session.shop;
    let timezone = null;
    try {
        const result = await executeShopifyGraphql({
            session,
            query: SHOP_TIMEZONE_QUERY,
            variables: {},
            cost: 1,
        });
        timezone = result.data?.shop?.ianaTimezone ?? null;
        if (timezone) {
            await prisma.shop.update({
                where: { shopDomain },
                data: { timezone },
            });
            logger.info({ shop: shopDomain, timezone }, "Fetched and saved shop timezone");
        }
    }
    catch (err) {
        logger.warn({ shop: shopDomain, err }, "Failed to fetch shop timezone, will retry on next request");
    }
    return timezone;
}
