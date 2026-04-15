/**
 * File: server/modules/shop/shop.service.ts
 * Purpose: Persist the canonical shop installation record, encrypted
 * offline access token, and idempotently bootstrap install-time credit
 * buckets within the same database transaction after Shopify
 * authentication completes.
 */
import { randomUUID } from "node:crypto";
import {
  CreditBucketStatus,
  CreditBucketType,
  Prisma,
} from "@prisma/client";
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
const INSTALL_WELCOME_CYCLE_KEY = "WELCOME:INSTALL";
const INSTALL_WELCOME_GRANT_AMOUNT = 50;
const FREE_MONTHLY_INCLUDED_GRANT_AMOUNT = 25;

function assertOfflineSession(session: ShopifySessionSnapshot): string {
  if (session.isOnline) {
    throw new Error("Expected an offline Shopify session");
  }

  if (!session.accessToken) {
    throw new Error("Offline Shopify session is missing an access token");
  }

  return session.accessToken;
}

function buildFreeMonthlyCycleKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");

  return `FREE:${year}-${month}`;
}

function getNextUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function buildInstallCreditBuckets(
  shopId: string,
  installedAt: Date,
): Prisma.CreditBucketCreateManyInput[] {
  return [
    {
      shopId,
      bucketType: CreditBucketType.WELCOME,
      status: CreditBucketStatus.ACTIVE,
      cycleKey: INSTALL_WELCOME_CYCLE_KEY,
      grantedAmount: INSTALL_WELCOME_GRANT_AMOUNT,
      reservedAmount: 0,
      consumedAmount: 0,
      effectiveAt: installedAt,
      expiresAt: null,
      activatedAt: installedAt,
      exhaustedAt: null,
    },
    {
      shopId,
      bucketType: CreditBucketType.FREE_MONTHLY_INCLUDED,
      status: CreditBucketStatus.ACTIVE,
      cycleKey: buildFreeMonthlyCycleKey(installedAt),
      grantedAmount: FREE_MONTHLY_INCLUDED_GRANT_AMOUNT,
      reservedAmount: 0,
      consumedAmount: 0,
      effectiveAt: installedAt,
      expiresAt: getNextUtcMonthStart(installedAt),
      activatedAt: installedAt,
      exhaustedAt: null,
    },
  ];
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

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
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

    const result = await tx.creditBucket.createMany({
      data: buildInstallCreditBuckets(shop.id, installedAt),
      skipDuplicates: true,
    });

    logger.info(
      {
        shop: session.shop,
        sessionId: session.id,
        createdBucketCount: result.count,
      },
      "Persisted shop installation and bootstrapped install credit buckets",
    );
  });
}
