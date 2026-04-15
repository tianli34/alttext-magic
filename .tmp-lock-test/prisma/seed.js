/**
 * File: prisma/seed.ts
 * Purpose: Seed the shops table with test records using encrypted access tokens.
 *
 * Uses inline AES-256-GCM encryption (same algorithm as token-encryption.ts)
 * to avoid importing the full env validation chain.
 */
import dotenv from "dotenv";
dotenv.config();
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Pool } from "pg";
// ── Inline encryption (mirrors server/crypto/token-encryption.ts) ─────
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const ENCRYPTION_KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
if (!process.env.TOKEN_ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
}
function encryptToken(plaintext) {
    const nonce = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, nonce);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted: encrypted.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
    };
}
// ── Prisma client ─────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// ── Test data ─────────────────────────────────────────────────────────
const TEST_SHOPS = [
    {
        shopDomain: "test-store-1.myshopify.com",
        accessToken: "shpat_test_token_alpha_001",
        scopes: "read_products,write_products,read_content",
        scanScopeFlags: {
            PRODUCT_MEDIA: true,
            FILES: true,
            COLLECTION_IMAGE: true,
            ARTICLE_IMAGE: true,
        },
    },
    {
        shopDomain: "test-store-2.myshopify.com",
        accessToken: "shpat_test_token_beta_002",
        scopes: "read_products,write_products",
        scanScopeFlags: {
            PRODUCT_MEDIA: true,
            FILES: false,
            COLLECTION_IMAGE: true,
            ARTICLE_IMAGE: false,
        },
    },
    {
        shopDomain: "test-store-3.myshopify.com",
        accessToken: "shpat_test_token_gamma_003",
        scopes: "read_content,write_content",
        scanScopeFlags: {
            PRODUCT_MEDIA: false,
            FILES: true,
            COLLECTION_IMAGE: false,
            ARTICLE_IMAGE: true,
        },
    },
];
async function main() {
    console.log("🌱 Seeding shops table...\n");
    for (const shop of TEST_SHOPS) {
        const encrypted = encryptToken(shop.accessToken);
        const now = new Date();
        const serializedScanScopeFlags = JSON.stringify(shop.scanScopeFlags);
        const [record] = await prisma.$queryRaw(Prisma.sql `
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
          ${shop.shopDomain},
          ${encrypted.encrypted},
          ${encrypted.nonce},
          ${encrypted.tag},
          ${shop.scopes},
          ${"FREE"},
          ${serializedScanScopeFlags}::jsonb,
          ${now},
          NULL,
          ${now},
          ${now}
        )
        ON CONFLICT ("shop_domain") DO UPDATE
        SET
          "access_token_encrypted" = EXCLUDED."access_token_encrypted",
          "access_token_nonce" = EXCLUDED."access_token_nonce",
          "access_token_tag" = EXCLUDED."access_token_tag",
          "scopes" = EXCLUDED."scopes",
          "current_plan" = EXCLUDED."current_plan",
          "scan_scope_flags" = EXCLUDED."scan_scope_flags",
          "uninstalled_at" = NULL,
          "updated_at" = EXCLUDED."updated_at"
        RETURNING
          "id",
          "shop_domain" AS "shopDomain",
          "current_plan" AS "currentPlan",
          "scan_scope_flags" AS "scanScopeFlags",
          "installed_at" AS "installedAt"
      `);
        console.log(`✅ Upserted: ${record.shopDomain} (id=${record.id})`);
        console.log(`   encrypted=${encrypted.encrypted.slice(0, 20)}... nonce=${encrypted.nonce.slice(0, 12)}... tag=${encrypted.tag.slice(0, 12)}...`);
        console.log(`   currentPlan=${record.currentPlan} scanScopeFlags=${JSON.stringify(record.scanScopeFlags)} installedAt=${record.installedAt.toISOString()}`);
        console.log();
    }
    console.log(`🎉 Seeded ${TEST_SHOPS.length} shop records.`);
}
main()
    .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
});
