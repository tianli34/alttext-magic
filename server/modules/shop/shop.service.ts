/**
 * File: server/modules/shop/shop.service.ts
 * Purpose: Persist the canonical shop installation record and encrypted
 * offline access token after Shopify authentication completes.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { encryptToken } from "../../crypto/token-encryption";
import { createLogger } from "../../utils/logger";
import { DEFAULT_SCAN_SCOPE_FLAGS } from "./scope.service";
import type {
  PersistOfflineShopSessionInput,
  ShopifySessionSnapshot,
} from "./shop.types";

const logger = createLogger({ module: "shop-service" });
const DEFAULT_PLAN = "FREE";

function assertOfflineSession(session: ShopifySessionSnapshot): string {
  if (session.isOnline) {
    throw new Error("Expected an offline Shopify session");
  }

  if (!session.accessToken) {
    throw new Error("Offline Shopify session is missing an access token");
  }

  return session.accessToken;
}

export async function persistOfflineShopSession({
  session,
}: PersistOfflineShopSessionInput): Promise<void> {
  if (session.isOnline) {
    logger.debug(
      { shop: session.shop, sessionId: session.id },
      "Skipping shop persistence for online session",
    );
    return;
  }

  const accessToken = assertOfflineSession(session);
  const encryptedToken = encryptToken(accessToken);
  const installedAt = new Date();
  const serializedScanScopeFlags = JSON.stringify(DEFAULT_SCAN_SCOPE_FLAGS);

  await prisma.$executeRaw(
    Prisma.sql`
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
    `,
  );

  logger.info(
    { shop: session.shop, sessionId: session.id },
    "Persisted shop installation and encrypted offline token",
  );
}
