/**
 * File: scripts/verify-shops.ts
 * Purpose: Verify seeded shop records — database integrity + encryption round-trip.
 *
 * Uses inline AES-256-GCM decryption (same algorithm as token-encryption.ts)
 * to avoid importing the full env validation chain.
 *
 * Checks:
 *   1. shopDomain correct
 *   2. installedAt set
 *   3. currentPlan = FREE
 *   4. scanScopeFlags correct
 *   5. accessTokenEncrypted non-empty
 *   6. Decryption round-trip succeeds
 */
import dotenv from "dotenv";
dotenv.config();

import { createDecipheriv } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  normalizeScopeFlagState,
  type ScopeFlagState,
} from "../app/lib/scope-utils";

// ── Inline decryption (mirrors server/crypto/token-encryption.ts) ─────
const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY = Buffer.from(
  process.env.TOKEN_ENCRYPTION_KEY!,
  "hex",
);

if (!process.env.TOKEN_ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
  throw new Error(
    "TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)",
  );
}

function decryptToken(
  encryptedToken: string,
  nonce: string,
  tag: string,
): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    ENCRYPTION_KEY,
    Buffer.from(nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return (
    decipher.update(Buffer.from(encryptedToken, "base64"), undefined, "utf8") +
    decipher.final("utf8")
  );
}

// ── Prisma client ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Expected data ─────────────────────────────────────────────────────
const EXPECTED: Record<
  string,
  { accessToken: string; scanScopeFlags: ScopeFlagState }
> = {
  "test-store-1.myshopify.com": {
    accessToken: "shpat_test_token_alpha_001",
    scanScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: true,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: true,
    },
  },
  "test-store-2.myshopify.com": {
    accessToken: "shpat_test_token_beta_002",
    scanScopeFlags: {
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: false,
    },
  },
  "test-store-3.myshopify.com": {
    accessToken: "shpat_test_token_gamma_003",
    scanScopeFlags: {
      PRODUCT_MEDIA: false,
      FILES: true,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: true,
    },
  },
};

function pass(label: string) {
  console.log(`  ✅ ${label}`);
}

function fail(label: string, detail: string) {
  console.error(`  ❌ ${label}: ${detail}`);
}

interface VerifiedShopRecord {
  shopDomain: string;
  installedAt: Date;
  currentPlan: string;
  scanScopeFlags: ScopeFlagState;
  accessTokenEncrypted: string;
  accessTokenNonce: string;
  accessTokenTag: string;
}

async function main() {
  console.log("🔍 Verifying shops table...\n");

  const shops = await prisma.$queryRaw<VerifiedShopRecord[]>(
    Prisma.sql`
      SELECT
        "shop_domain" AS "shopDomain",
        "installed_at" AS "installedAt",
        "current_plan" AS "currentPlan",
        "scan_scope_flags" AS "scanScopeFlags",
        "access_token_encrypted" AS "accessTokenEncrypted",
        "access_token_nonce" AS "accessTokenNonce",
        "access_token_tag" AS "accessTokenTag"
      FROM "shops"
      ORDER BY "created_at" ASC
    `,
  );

  console.log(`Found ${shops.length} shop records in DB.\n`);

  let allOk = true;

  for (const shop of shops) {
    const expected = EXPECTED[shop.shopDomain];
    console.log(`── ${shop.shopDomain} ──`);

    // Check 1: shopDomain exists in expected set
    if (!expected) {
      fail("shopDomain", `unexpected domain: ${shop.shopDomain}`);
      allOk = false;
      continue;
    }
    pass(`shopDomain = ${shop.shopDomain}`);

    // Check 2: installedAt
    if (!shop.installedAt || shop.installedAt.getTime() === 0) {
      fail("installedAt", "missing or zero");
      allOk = false;
    } else {
      pass(`installedAt = ${shop.installedAt.toISOString()}`);
    }

    // Check 3: currentPlan = FREE
    if (shop.currentPlan !== "FREE") {
      fail("currentPlan", `expected FREE, got ${shop.currentPlan}`);
      allOk = false;
    } else {
      pass("currentPlan = FREE");
    }

    // Check 4: scanScopeFlags
    const actualScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
    const expectedScopeFlags = normalizeScopeFlagState(expected.scanScopeFlags);

    if (
      JSON.stringify(actualScopeFlags) !== JSON.stringify(expectedScopeFlags)
    ) {
      fail(
        "scanScopeFlags",
        `expected ${JSON.stringify(expectedScopeFlags)}, got ${JSON.stringify(actualScopeFlags)}`,
      );
      allOk = false;
    } else {
      pass(`scanScopeFlags = ${JSON.stringify(actualScopeFlags)}`);
    }

    // Check 5: accessTokenEncrypted non-empty
    if (
      !shop.accessTokenEncrypted ||
      !shop.accessTokenNonce ||
      !shop.accessTokenTag
    ) {
      fail(
        "accessTokenEncrypted",
        "encrypted / nonce / tag must all be non-empty",
      );
      allOk = false;
    } else {
      pass(
        `accessTokenEncrypted = ${shop.accessTokenEncrypted.slice(0, 24)}... (${shop.accessTokenEncrypted.length} chars)`,
      );
    }

    // Check 6: Decryption round-trip
    try {
      const decrypted = decryptToken(
        shop.accessTokenEncrypted,
        shop.accessTokenNonce,
        shop.accessTokenTag,
      );

      if (decrypted !== expected.accessToken) {
        fail(
          "decrypt round-trip",
          `expected "${expected.accessToken}", got "${decrypted}"`,
        );
        allOk = false;
      } else {
        pass(`decrypt round-trip OK → ${decrypted}`);
      }
    } catch (err) {
      fail("decrypt round-trip", String(err));
      allOk = false;
    }

    console.log();
  }

  // ── Summary ─────────────────────────────────────────────────────────
  if (allOk) {
    console.log("🎉 All checks passed!");
  } else {
    console.error("⚠️  Some checks failed — see above.");
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("❌ Verification failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
