/**
 * 一次性脚本：回填所有存量店铺的时区。
 * 遍历 shops 表中 timezone IS NULL 的店铺，
 * 解密 accessToken → 调用 Shopify Admin GraphQL 获取 ianaTimezone → 写入 DB。
 *
 * 使用方式：
 *   npx tsx scripts/backfill-shop-timezone.ts
 */
import prisma from "../server/db/prisma.server";
import { decryptToken } from "../server/crypto/token-encryption";
import { executeShopifyGraphql } from "../server/modules/writeback/mutations/mutation-utils";
import { SHOP_TIMEZONE_QUERY } from "../server/shopify/queries/shop.query";
import type { ShopTimezoneResponse } from "../server/shopify/queries/shop.query";

async function main() {
  const shops = await prisma.shop.findMany({
    where: { timezone: null, uninstalledAt: null },
    select: {
      id: true,
      shopDomain: true,
      accessTokenEncrypted: true,
      accessTokenNonce: true,
      accessTokenTag: true,
    },
  });

  if (shops.length === 0) {
    console.log("没有需要回填时区的店铺");
    return;
  }

  for (const shop of shops) {
    const accessToken = decryptToken(
      shop.accessTokenEncrypted,
      shop.accessTokenNonce,
      shop.accessTokenTag,
    );

    try {
      const session = {
        shop: shop.shopDomain,
        accessToken,
      };

      const result = await executeShopifyGraphql<ShopTimezoneResponse>({
        session: session as never,
        query: SHOP_TIMEZONE_QUERY,
        variables: {},
        cost: 1,
      });

      const timezone = result.data?.shop?.ianaTimezone ?? null;

      if (timezone) {
        await prisma.shop.update({
          where: { id: shop.id },
          data: { timezone },
        });
        console.log(`[OK] ${shop.shopDomain} → ${timezone}`);
      } else {
        console.warn(`[SKIP] ${shop.shopDomain} → 无 timezone 返回`);
      }
    } catch (err) {
      console.error(`[FAIL] ${shop.shopDomain}:`, err);
    }
  }
}

main()
  .then(() => {
    console.log("回填完成");
    process.exit(0);
  })
  .catch((err) => {
    console.error("脚本异常退出:", err);
    process.exit(1);
  });
