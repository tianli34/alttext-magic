/**
 * File: tests/candidates.service.test.ts
 * Purpose: 候选列表服务单测，覆盖 scope、状态过滤与游标分页。
 */
import assert from "node:assert/strict";
import {
  AltCandidateStatus,
  CandidateGroupPrimaryUsageType,
  CandidateGroupType,
} from "@prisma/client";
import {
  listCandidates,
  type CandidateListDataAccess,
  type CandidateListRow,
} from "../server/modules/candidate/candidate-list.server";
import type { ScanScopeFlags } from "../server/modules/shop/shop.types";

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

function createRow(
  overrides: Partial<CandidateListRow> = {},
): CandidateListRow {
  return {
    id: "cgp-001",
    altCandidateId: "candidate-001",
    thumbnailUrl: "https://cdn.example.com/image.jpg",
    groupType: CandidateGroupType.PRODUCT_MEDIA,
    primaryUsageType: CandidateGroupPrimaryUsageType.PRODUCT,
    primaryUsageId: "gid://shopify/Product/1",
    primaryTitle: "测试商品",
    primaryHandle: "test-product",
    primaryPositionIndex: 1,
    additionalUsageCount: 0,
    usageCountPresent: 1,
    impactScopeSummary: {},
    contextMode: null,
    candidateStatus: AltCandidateStatus.MISSING,
    currentAltEmpty: true,
    decorativeActive: false,
    currentAlt: null,
    draftAlt: null,
    ...overrides,
  };
}

function createDataAccess(
  rows: CandidateListRow[],
  capture: {
    groups?: readonly CandidateGroupType[];
    cursor?: string;
    status?: string;
    limit?: number;
    called?: boolean;
  },
): CandidateListDataAccess {
  return {
    async getShop() {
      return {
        scanScopeFlags: allScopes,
        lastPublishedScopeFlags: productOnlyPublishedScopes,
      };
    },
    async getRows(_shopId, groups, query) {
      capture.called = true;
      capture.groups = groups;
      capture.cursor = query.cursor;
      capture.status = query.status;
      capture.limit = query.limit;
      return rows;
    },
  };
}

async function run(): Promise<void> {
  {
    const capture: { groups?: readonly CandidateGroupType[] } = {};
    const data = await listCandidates(
      "shop-1",
      { group: CandidateGroupType.PRODUCT_MEDIA },
      createDataAccess([createRow()], capture),
    );

    assert.deepEqual(
      capture.groups,
      [CandidateGroupType.PRODUCT_MEDIA],
      "group=PRODUCT_MEDIA 只应查询产品媒体分组",
    );
    assert.equal(data.items.length, 1, "应返回产品媒体候选");
    assert.equal(data.items[0].groupType, CandidateGroupType.PRODUCT_MEDIA);
  }

  {
    const capture: { called?: boolean } = {};
    const dataAccess: CandidateListDataAccess = {
      async getShop() {
        return {
          scanScopeFlags: allScopes,
          lastPublishedScopeFlags: productOnlyPublishedScopes,
        };
      },
      async getRows() {
        capture.called = true;
        return [createRow({ groupType: CandidateGroupType.FILES })];
      },
    };

    const data = await listCandidates(
      "shop-1",
      { group: CandidateGroupType.FILES },
      dataAccess,
    );

    assert.equal(capture.called, undefined, "out-of-scope group 不应执行主查询");
    assert.deepEqual(data, { items: [], nextCursor: null });
  }

  {
    const capture: { status?: string } = {};
    const data = await listCandidates(
      "shop-1",
      { status: "MISSING" },
      createDataAccess(
        [
          createRow({
            id: "cgp-002",
            currentAltEmpty: true,
            decorativeActive: false,
          }),
        ],
        capture,
      ),
    );

    assert.equal(capture.status, "MISSING", "MISSING 过滤条件应传入查询层");
    assert.equal(data.items[0].status, "MISSING");
    assert.equal(data.items[0].currentAlt, null);
  }

  {
    const capture: { cursor?: string; limit?: number } = {};
    const data = await listCandidates(
      "shop-1",
      { cursor: "cgp-010", limit: 2 },
      createDataAccess(
        [
          createRow({ id: "cgp-011", altCandidateId: "candidate-011" }),
          createRow({ id: "cgp-012", altCandidateId: "candidate-012" }),
          createRow({ id: "cgp-013", altCandidateId: "candidate-013" }),
        ],
        capture,
      ),
    );

    assert.equal(capture.cursor, "cgp-010", "游标应传入查询层");
    assert.equal(capture.limit, 2, "limit 应传入查询层");
    assert.deepEqual(
      data.items.map((item) => item.id),
      ["cgp-011", "cgp-012"],
      "分页应截取 limit 条，避免重复暴露探测行",
    );
    assert.equal(data.nextCursor, "cgp-012", "有下一页时 nextCursor 为本页最后 id");
  }

  {
    const capture: { status?: string; groups?: readonly CandidateGroupType[] } = {};
    const data = await listCandidates(
      "shop-1",
      {
        group: CandidateGroupType.PRODUCT_MEDIA,
        status: "HAS_ALT",
        limit: 50,
      },
      createDataAccess(
        [
          createRow({
            id: "cgp-020",
            currentAltEmpty: false,
            currentAlt: "Existing alt",
            candidateStatus: AltCandidateStatus.RESOLVED,
          }),
        ],
        capture,
      ),
    );

    assert.deepEqual(
      capture.groups,
      [CandidateGroupType.PRODUCT_MEDIA],
      "组合过滤应保留 group 条件",
    );
    assert.equal(capture.status, "HAS_ALT", "组合过滤应保留 status 条件");
    assert.equal(data.items[0].status, "HAS_ALT");
    assert.equal(data.items[0].currentAlt, "Existing alt");
    assert.equal(data.nextCursor, null);
  }

  console.log("✅ candidates.service 单测全部通过");
}

run().catch((err: unknown) => {
  console.error("❌ candidates.service 单测失败", err);
  process.exit(1);
});
