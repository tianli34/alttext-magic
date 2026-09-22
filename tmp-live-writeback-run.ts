/**
 * 临时脚本: 供 tests/writeback-file-live.ts 注入真实店铺凭据并回读验证。
 * 用完即删。token 仅存在于进程内存, 不输出。
 */
import "dotenv/config";
import prisma from "./server/db/prisma.server.js";
import { decryptToken } from "./server/crypto/token-encryption.js";

const SHOP = "magic-ai-test-01.myshopify.com";
const GID = "gid://shopify/MediaImage/28931872620678";
const API = `https://${SHOP}/admin/api/2026-04/graphql.json`;

const READ = /* GraphQL */ `
  query ReadFile($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        alt
        status
      }
    }
  }
`;

async function read(token: string, label: string): Promise<void> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: READ, variables: { id: GID } }),
  });
  const body = (await res.json()) as {
    data?: { node?: { alt?: string | null; status?: string | null } | null };
    errors?: Array<{ message: string }>;
  };
  console.log(
    `[${label}] http=${res.status} alt=${JSON.stringify(body.data?.node?.alt)} status=${body.data?.node?.status} errors=${JSON.stringify(body.errors ?? null)}`,
  );
}

const shop = await prisma.shop.findUnique({ where: { shopDomain: SHOP } });
if (!shop) {
  throw new Error(`shop ${SHOP} not found in local DB`);
}

const token = decryptToken(
  shop.accessTokenEncrypted,
  shop.accessTokenNonce,
  shop.accessTokenTag,
);
console.log(`token decrypted: prefix=${token.slice(0, 8)}… len=${token.length}`);

await read(token, "before");

process.env.SHOPIFY_WRITEBACK_TEST_SHOP = SHOP;
process.env.SHOPIFY_WRITEBACK_TEST_TOKEN = token;
process.env.SHOPIFY_WRITEBACK_TEST_MEDIA_IMAGE_GID = GID;

await import("./tests/writeback-file-live.js");

await read(token, "after");

await prisma.$disconnect();
process.exit(0);
