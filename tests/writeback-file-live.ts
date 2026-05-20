/**
 * File: tests/writeback-file-live.ts
 * Purpose: 开发店铺 fileUpdate 写回 smoke test。
 *
 * 运行:
 *   $env:SHOPIFY_WRITEBACK_TEST_SHOP="test-shop.myshopify.com"
 *   $env:SHOPIFY_WRITEBACK_TEST_TOKEN="shpat_xxx"
 *   $env:SHOPIFY_WRITEBACK_TEST_MEDIA_IMAGE_GID="gid://shopify/MediaImage/123"
 *   node --import tsx tests/writeback-file-live.ts
 */

import type { Session } from "@shopify/shopify-api";
import { FileAltExecutor } from "../server/modules/writeback/mutations/file-update.mutation.js";

const shop = process.env.SHOPIFY_WRITEBACK_TEST_SHOP;
const accessToken = process.env.SHOPIFY_WRITEBACK_TEST_TOKEN;
const mediaImageGid = process.env.SHOPIFY_WRITEBACK_TEST_MEDIA_IMAGE_GID;
const altText =
  process.env.SHOPIFY_WRITEBACK_TEST_ALT_TEXT ??
  `AltText Magic live smoke ${new Date().toISOString()}`;

if (!shop || !accessToken || !mediaImageGid) {
  console.log(
    "SKIP: set SHOPIFY_WRITEBACK_TEST_SHOP, SHOPIFY_WRITEBACK_TEST_TOKEN, SHOPIFY_WRITEBACK_TEST_MEDIA_IMAGE_GID to run live fileUpdate.",
  );
  process.exit(0);
}

const session = {
  id: `offline_${shop}`,
  shop,
  state: "",
  isOnline: false,
  accessToken,
} as Session;

const result = await new FileAltExecutor().execute({
  session,
  shopifyGid: mediaImageGid,
  altText,
});

console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exit(1);
}
