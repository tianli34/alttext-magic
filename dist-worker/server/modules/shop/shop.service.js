/**
 * File: server/modules/shop/shop.service.ts
 * Purpose: Persist the canonical shop installation record and encrypted
 * offline access token after Shopify authentication completes。
 * 计费与额度初始化已迁移至 bootstrapShopBilling 服务。
 */
import { randomUUID } from "node:crypto";
import prisma from "../../db/prisma.server";
import { encryptToken } from "../../crypto/token-encryption";
import { createLogger } from "../../utils/logger";
import { DEFAULT_SCAN_SCOPE_FLAGS } from "./scope.service";
const logger = createLogger({ module: "shop-service" });
const DEFAULT_PLAN = "FREE";
function assertOfflineSession(session) {
    if (session.isOnline) {
        throw new Error("Expected an offline Shopify session");
    }
    if (!session.accessToken) {
        throw new Error("Offline Shopify session is missing an access token");
    }
    return session.accessToken;
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
    const accessToken = assertOfflineSession(session);
    const encryptedToken = encryptToken(accessToken);
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
        ${encryptedToken.encrypted},
        ${encryptedToken.nonce},
        ${encryptedToken.tag},
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
        "access_token_encrypted" = EXCLUDED."access_token_encrypted",
        "access_token_nonce" = EXCLUDED."access_token_nonce",
        "access_token_tag" = EXCLUDED."access_token_tag",
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
