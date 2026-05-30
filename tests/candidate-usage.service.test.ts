/**
 * File: tests/candidate-usage.service.test.ts
 * Purpose: 候选 Usage 详情服务单测，覆盖 scope 过滤、group 过滤、归属校验与 URL 构建。
 */
import assert from "node:assert/strict";
import { CandidateGroupType, ImageUsageType } from "@prisma/client";
import {
  listCandidateUsages,
  buildShopifyAdminUrl,
  type UsageDetailDataAccess,
  type UsageDetailUsageRow,
  type UsageDetailCandidateRow,
  type UsageDetailProjectionRow,
} from "../server/modules/candidate/candidate-usage.service";
import type { ScanScopeFlags } from "../server/modules/shop/shop.types";

/* ------------------------------------------------------------------ */
/*  测试数据                                                           */
/* ------------------------------------------------------------------ */

const allScopes: ScanScopeFlags = {
  PRODUCT_MEDIA: true,
  FILES: true,
  COLLECTION_IMAGE: true,
  ARTICLE_IMAGE: true,
};

const productOnlyPublishedScopes: ScanScopeFlags = {
  PRODUCT_MEDIA: true,
  FILES: false,
  COLLECTION_IMAGE: false,
  ARTICLE_IMAGE: false,
};

const presentCandidate: UsageDetailCandidateRow = {
  altTargetId: "target-1",
  currentAlt: null,
  targetPresent: true,
};

const notFoundCandidate: UsageDetailCandidateRow = {
  altTargetId: "target-2",
  currentAlt: "old alt",
  targetPresent: false,
};

function createUsageRow(
  overrides: Partial<UsageDetailUsageRow> = {},
): UsageDetailUsageRow {
  return {
    usageType: ImageUsageType.PRODUCT,
    usageId: "gid://shopify/Product/123",
    title: "测试商品",
    handle: "test-product",
    positionIndex: 0,
    ...overrides,
  };
}

function nullProjection(): UsageDetailProjectionRow | null {
  return null;
}

/** 构建数据访问层 mock，默认 product-only scope */
function createProductOnlyDataAccess(
  candidate: UsageDetailCandidateRow | null,
  usages: UsageDetailUsageRow[],
  capture: { altTargetId?: string; called?: boolean } = {},
): UsageDetailDataAccess {
  return {
    async getCandidate() {
      return candidate;
    },
    async getShop() {
      return {
        shopDomain: "test-shop.myshopify.com",
        scanScopeFlags: allScopes,
        lastPublishedScopeFlags: productOnlyPublishedScopes,
      };
    },
    async getUsages(altTargetId) {
      capture.called = true;
      capture.altTargetId = altTargetId;
      return usages;
    },
    async getProjection() {
      return nullProjection();
    },
  };
}

/** 构建全 scope 数据访问层 mock */
function createAllScopeDataAccess(
  candidate: UsageDetailCandidateRow | null,
  usages: UsageDetailUsageRow[],
  capture: { altTargetId?: string; called?: boolean } = {},
  projection?: UsageDetailProjectionRow | null,
): UsageDetailDataAccess {
  return {
    async getCandidate() {
      return candidate;
    },
    async getShop() {
      return {
        shopDomain: "test-shop.myshopify.com",
        scanScopeFlags: allScopes,
        lastPublishedScopeFlags: allScopes,
      };
    },
    async getUsages(altTargetId) {
      capture.called = true;
      capture.altTargetId = altTargetId;
      return usages;
    },
    async getProjection() {
      return projection ?? nullProjection();
    },
  };
}

/* ------------------------------------------------------------------ */
/*  测试用例                                                           */
/* ------------------------------------------------------------------ */

async function run(): Promise<void> {
  /* ---- 1. 正常返回 PRODUCT 类型 usage ---- */
  {
    const capture: { called?: boolean; altTargetId?: string } = {};
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      createProductOnlyDataAccess(presentCandidate, [createUsageRow()], capture),
    );

    assert.equal(capture.called, true, "应查询 usages");
    assert.equal(capture.altTargetId, "target-1", "应以正确的 altTargetId 查询");
    assert.equal(data.usages.length, 1, "应返回 1 条 usage");
    assert.equal(data.usages[0].usageType, ImageUsageType.PRODUCT);
    assert.equal(data.usages[0].usageId, "gid://shopify/Product/123");
    assert.equal(data.usages[0].title, "测试商品");
    assert.equal(data.usages[0].handle, "test-product");
    assert.equal(data.usages[0].positionIndex, 0);
    assert.equal(data.usages[0].currentAlt, null);
    assert.equal(
      data.usages[0].shopifyAdminUrl,
      "https://test-shop.myshopify.com/admin/products/123",
    );
  }

  /* ---- 2. out-of-scope FILE usage 被过滤 ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      createProductOnlyDataAccess(
        { ...presentCandidate, currentAlt: "existing alt" },
        [
          createUsageRow({ usageType: ImageUsageType.PRODUCT }),
          createUsageRow({
            usageType: ImageUsageType.FILE,
            usageId: "gid://shopify/MediaImage/456",
            title: null,
            handle: null,
            positionIndex: null,
          }),
        ],
      ),
    );

    assert.equal(data.usages.length, 1, "FILE out-of-scope 应被过滤，只剩 PRODUCT");
    assert.equal(data.usages[0].usageType, ImageUsageType.PRODUCT);
    assert.equal(data.usages[0].currentAlt, "existing alt");
  }

  /* ---- 3. 全 scope 时共享文件同时包含 PRODUCT 和 FILE ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      createAllScopeDataAccess(
        presentCandidate,
        [
          createUsageRow({ usageType: ImageUsageType.PRODUCT, positionIndex: 0 }),
          createUsageRow({
            usageType: ImageUsageType.FILE,
            usageId: "gid://shopify/MediaImage/456",
            title: null,
            handle: null,
            positionIndex: null,
          }),
        ],
      ),
    );

    assert.equal(data.usages.length, 2, "全 scope 应返回 PRODUCT + FILE");
    assert.equal(data.usages[0].usageType, ImageUsageType.PRODUCT);
    assert.equal(data.usages[1].usageType, ImageUsageType.FILE);
    assert.equal(
      data.usages[1].shopifyAdminUrl,
      "https://test-shop.myshopify.com/admin/settings/files",
    );
  }

  /* ---- 4. group 过滤：group=FILES 只返回 FILE usage ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      CandidateGroupType.FILES,
      createAllScopeDataAccess(
        presentCandidate,
        [
          createUsageRow({ usageType: ImageUsageType.PRODUCT }),
          createUsageRow({
            usageType: ImageUsageType.FILE,
            usageId: "gid://shopify/MediaImage/456",
            title: null,
            handle: null,
            positionIndex: null,
          }),
        ],
      ),
    );

    assert.equal(data.usages.length, 1, "group=FILES 只返回 FILE usage");
    assert.equal(data.usages[0].usageType, ImageUsageType.FILE);
  }

  /* ---- 5. group 过滤：group=PRODUCT_MEDIA 只返回 PRODUCT usage ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      CandidateGroupType.PRODUCT_MEDIA,
      createAllScopeDataAccess(
        presentCandidate,
        [
          createUsageRow({ usageType: ImageUsageType.PRODUCT }),
          createUsageRow({
            usageType: ImageUsageType.FILE,
            usageId: "gid://shopify/MediaImage/456",
            title: null,
            handle: null,
            positionIndex: null,
          }),
        ],
      ),
    );

    assert.equal(data.usages.length, 1, "group=PRODUCT_MEDIA 只返回 PRODUCT usage");
    assert.equal(data.usages[0].usageType, ImageUsageType.PRODUCT);
  }

  /* ---- 6. 候选不存在 ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "nonexistent",
      undefined,
      createProductOnlyDataAccess(null, []),
    );

    assert.deepEqual(data, { usages: [] });
  }

  /* ---- 7. alt_target NOT_FOUND → 返回空 ---- */
  {
    const capture: { called?: boolean } = {};
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      createProductOnlyDataAccess(notFoundCandidate, [], capture),
    );

    assert.equal(capture.called, undefined, "alt_target NOT_FOUND 不应查询 usages");
    assert.deepEqual(data, { usages: [] });
  }

  /* ---- 8. 无 PRESENT usage 返回空列表 ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      createProductOnlyDataAccess(presentCandidate, []),
    );

    assert.equal(data.usages.length, 0, "无 PRESENT usage 时返回空列表");
  }

  /* ---- 9. group=FILES 但 FILES scope 未开启 ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      CandidateGroupType.FILES,
      createProductOnlyDataAccess(
        presentCandidate,
        [
          createUsageRow({
            usageType: ImageUsageType.FILE,
            usageId: "gid://shopify/MediaImage/456",
            title: null,
            handle: null,
            positionIndex: null,
          }),
        ],
      ),
    );

    assert.equal(data.usages.length, 0, "group=FILES 但 scope 不包含 FILES 应返回空");
  }

  /* ---- 10. group=COLLECTION 无 ImageUsage 时返回 SELF 自引用 ---- */
  {
    const projection: UsageDetailProjectionRow = {
      groupType: "COLLECTION",
      primaryUsageType: "SELF",
      primaryUsageId: "gid://shopify/Collection/789",
      primaryTitle: "夏季精选",
      primaryHandle: "summer-picks",
    };
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      CandidateGroupType.COLLECTION,
      createAllScopeDataAccess(
        presentCandidate,
        [createUsageRow({ usageType: ImageUsageType.PRODUCT })],
        {},
        projection,
      ),
    );

    assert.equal(data.usages.length, 1, "COLLECTION group 应返回 SELF 自引用");
    assert.equal(data.usages[0].usageType, "COLLECTION");
    assert.equal(data.usages[0].usageId, "gid://shopify/Collection/789");
    assert.equal(data.usages[0].title, null, "SELF 自引用不返回 title，优先展示 GID");
    assert.equal(data.usages[0].handle, null);
    assert.equal(data.usages[0].positionIndex, null);
    assert.equal(
      data.usages[0].shopifyAdminUrl,
      "https://test-shop.myshopify.com/admin/collections/789",
    );
  }

  /* ---- 10b. group=COLLECTION 且无 SELF projection 时仍返回空 ---- */
  {
    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      CandidateGroupType.COLLECTION,
      createAllScopeDataAccess(presentCandidate, []),
    );

    assert.equal(data.usages.length, 0, "无 SELF projection 时应返回空");
  }

  /* ---- 11. buildShopifyAdminUrl ---- */
  {
    assert.equal(
      buildShopifyAdminUrl("shop.myshopify.com", "PRODUCT", "gid://shopify/Product/789"),
      "https://shop.myshopify.com/admin/products/789",
    );
    assert.equal(
      buildShopifyAdminUrl("shop.myshopify.com", "COLLECTION", "gid://shopify/Collection/456"),
      "https://shop.myshopify.com/admin/collections/456",
    );
    assert.equal(
      buildShopifyAdminUrl("shop.myshopify.com", "ARTICLE", "gid://shopify/Article/123"),
      "https://shop.myshopify.com/admin/articles/123",
    );
    assert.equal(
      buildShopifyAdminUrl("shop.myshopify.com", "FILE", "gid://shopify/MediaImage/456"),
      "https://shop.myshopify.com/admin/settings/files",
    );
  }

  /* ---- 12. shop 不存在 ---- */
  {
    const noShopAccess: UsageDetailDataAccess = {
      async getCandidate() {
        return presentCandidate;
      },
      async getShop() {
        return null;
      },
      async getUsages() {
        return [];
      },
      async getProjection() {
        return null;
      },
    };

    const data = await listCandidateUsages(
      "shop-1",
      "candidate-1",
      undefined,
      noShopAccess,
    );

    assert.deepEqual(data, { usages: [] });
  }

  console.log("✅ candidate-usage.service 单测全部通过");
}

run().catch((err: unknown) => {
  console.error("❌ candidate-usage.service 单测失败", err);
  process.exit(1);
});
