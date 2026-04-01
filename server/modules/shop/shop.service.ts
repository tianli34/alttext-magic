/**
 * File: server/modules/shop/shop.service.ts
 * Purpose: Persist the canonical shop installation record and encrypted
 * offline access token after Shopify authentication completes.
 */
import prisma from "../../db/prisma.server";
import { encryptToken } from "../../crypto/token-encryption";
import { createLogger } from "../../utils/logger";
import {
  DEFAULT_SCAN_SCOPE_FLAGS,
  encodeScanScopeFlags,
} from "./scope.service";
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

  await prisma.shop.upsert({
    where: {
      shopDomain: session.shop,
    },
    create: {
      shopDomain: session.shop,
      accessTokenEncrypted: encryptedToken.encrypted,
      accessTokenNonce: encryptedToken.nonce,
      accessTokenTag: encryptedToken.tag,
      scopes: session.scope ?? null,
      currentPlan: DEFAULT_PLAN,
      scanScopeFlags: encodeScanScopeFlags(DEFAULT_SCAN_SCOPE_FLAGS),
      installedAt: new Date(),
      uninstalledAt: null,
    },
    update: {
      accessTokenEncrypted: encryptedToken.encrypted,
      accessTokenNonce: encryptedToken.nonce,
      accessTokenTag: encryptedToken.tag,
      scopes: session.scope ?? null,
      uninstalledAt: null,
    },
  });

  logger.info(
    { shop: session.shop, sessionId: session.id },
    "Persisted shop installation and encrypted offline token",
  );
}
