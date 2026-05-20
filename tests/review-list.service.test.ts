/**
 * File: tests/review-list.service.test.ts
 * Purpose: 审阅列表服务单测，覆盖空结果、筛选、分页边界与行映射。
 */
import assert from "node:assert/strict";
import {
  AltCandidateStatus,
  AltPlane,
  type CandidateGroupPrimaryUsageType,
} from "@prisma/client";
import {
  normalizePageSize,
  normalizePage,
  buildReviewWhere,
  buildReviewOrderBy,
  mapRowToItem,
  listReviewCandidates,
  REVIEW_VISIBLE_STATUSES,
  type ReviewListDataAccess,
  type ReviewRawRow,
} from "../server/modules/candidate/review-list.server";

// ─── 辅助函数 ───────────────────────────────────────────────

/** 创建模拟行数据 */
function createRow(
  overrides: Partial<ReviewRawRow> = {},
): ReviewRawRow {
  return {
    id: "cand-001",
    status: AltCandidateStatus.GENERATED,
    errorMessage: null,
    retryCount: 0,
    altPlane: AltPlane.FILE_ALT,
    isDecorative: false,
    shopifyGid: "gid://shopify/MediaImage/123",
    thumbnailUrl: "https://cdn.example.com/img.jpg",
    currentAltText: null,
    primaryUsageType: "FILE" as CandidateGroupPrimaryUsageType,
    primaryUsageId: "gid://shopify/Product/1",
    primaryTitle: "测试商品",
    primaryHandle: "test-product",
    primaryPositionIndex: 1,
    usageCountPresent: 1,
    aiGeneratedText: "AI 生成的替代文本",
    editedText: null,
    modelUsed: "gpt-4o",
    draftCreatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

/** 创建 mock 数据访问层 */
function createDataAccess(
  rows: ReviewRawRow[],
  total: number,
  capture: {
    where?: unknown;
    orderBy?: unknown;
    skip?: number;
    take?: number;
  } = {},
): ReviewListDataAccess {
  return {
    async getCandidates(_shopId, where, orderBy, skip, take) {
      capture.where = where;
      capture.orderBy = orderBy;
      capture.skip = skip;
      capture.take = take;
      return rows;
    },
    async getCount(_shopId, where) {
      capture.where = where;
      return total;
    },
  };
}

// ─── 测试主函数 ─────────────────────────────────────────────

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    Promise.resolve(fn())
      .then(() => {
        passed++;
        console.log(`  ✓ ${name}`);
      })
      .catch((err: Error) => {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
      });
  }

  console.log("review-list.service tests\n");

  // ── normalizePageSize ────────────────────────────────────
  test("normalizePageSize: undefined → 默认 20", () => {
    assert.equal(normalizePageSize(undefined), 20);
  });

  test("normalizePageSize: 超上限 → 50", () => {
    assert.equal(normalizePageSize(100), 50);
  });

  test("normalizePageSize: 低于 1 → 1", () => {
    assert.equal(normalizePageSize(0), 1);
  });

  test("normalizePageSize: 正常值原样返回", () => {
    assert.equal(normalizePageSize(30), 30);
  });

  // ── normalizePage ────────────────────────────────────────
  test("normalizePage: undefined → 1", () => {
    assert.equal(normalizePage(undefined), 1);
  });

  test("normalizePage: 0 → 1", () => {
    assert.equal(normalizePage(0), 1);
  });

  test("normalizePage: 正常值原样返回", () => {
    assert.equal(normalizePage(3), 3);
  });

  // ── buildReviewWhere ─────────────────────────────────────
  test("buildReviewWhere: 无筛选 → status in 全部可见状态", () => {
    const where = buildReviewWhere("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    });
    assert.deepEqual(
      (where.status as { in: string[] }).in,
      [...REVIEW_VISIBLE_STATUSES],
    );
  });

  test("buildReviewWhere: status=GENERATED → 只含 GENERATED", () => {
    const where = buildReviewWhere("shop-1", {
      status: AltCandidateStatus.GENERATED,
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    });
    assert.deepEqual(
      (where.status as { in: string[] }).in,
      [AltCandidateStatus.GENERATED],
    );
  });

  test("buildReviewWhere: altPlane=FILE_ALT → 含 altTarget 条件", () => {
    const where = buildReviewWhere("shop-1", {
      altPlane: AltPlane.FILE_ALT,
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    });
    assert.ok(where.altTarget);
    assert.deepEqual((where.altTarget as { altPlane: string }).altPlane, AltPlane.FILE_ALT);
  });

  test("buildReviewWhere: 无 altPlane → 不含 altTarget 条件", () => {
    const where = buildReviewWhere("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    });
    assert.equal(where.altTarget, undefined);
  });

  // ── buildReviewOrderBy ───────────────────────────────────
  test("buildReviewOrderBy: createdAt → { createdAt: desc }", () => {
    const orderBy = buildReviewOrderBy("createdAt");
    assert.deepEqual(orderBy, { createdAt: "desc" });
  });

  test("buildReviewOrderBy: altPlane → 嵌套排序", () => {
    const orderBy = buildReviewOrderBy("altPlane");
    assert.deepEqual(orderBy, { altTarget: { altPlane: "asc" } });
  });

  // ── mapRowToItem ─────────────────────────────────────────
  test("mapRowToItem: editedText 存在 → displayText 取 editedText", () => {
    const row = createRow({ editedText: "用户编辑的文本" });
    const item = mapRowToItem(row);
    assert.equal(item.displayText, "用户编辑的文本");
  });

  test("mapRowToItem: editedText 为 null → displayText 取 aiGeneratedText", () => {
    const row = createRow({ editedText: null });
    const item = mapRowToItem(row);
    assert.equal(item.displayText, "AI 生成的替代文本");
  });

  test("mapRowToItem: editedText 为纯空白 → displayText 取 aiGeneratedText", () => {
    const row = createRow({ editedText: "   " });
    const item = mapRowToItem(row);
    assert.equal(item.displayText, "AI 生成的替代文本");
  });

  test("mapRowToItem: usageCountPresent > 1 → isSharedFile=true", () => {
    const row = createRow({ usageCountPresent: 3 });
    const item = mapRowToItem(row);
    assert.equal(item.isSharedFile, true);
  });

  test("mapRowToItem: usageCountPresent = 1 → isSharedFile=false", () => {
    const row = createRow({ usageCountPresent: 1 });
    const item = mapRowToItem(row);
    assert.equal(item.isSharedFile, false);
  });

  test("mapRowToItem: isDecorative 正确映射", () => {
    const row = createRow({ isDecorative: true });
    const item = mapRowToItem(row);
    assert.equal(item.candidate.isDecorative, true);
  });

  test("mapRowToItem: 无 draft 数据 → draft=null", () => {
    const row = createRow({
      aiGeneratedText: null,
      editedText: null,
      modelUsed: null,
      draftCreatedAt: null,
    });
    const item = mapRowToItem(row);
    assert.equal(item.draft, null);
    assert.equal(item.displayText, "");
  });

  test("mapRowToItem: primaryUsageId=null → primaryUsage=null", () => {
    const row = createRow({
      primaryUsageId: null,
      primaryUsageType: null,
      primaryTitle: null,
      primaryHandle: null,
      primaryPositionIndex: null,
    });
    const item = mapRowToItem(row);
    assert.equal(item.target.primaryUsage, null);
  });

  // ── listReviewCandidates: 空结果 ─────────────────────────
  test("listReviewCandidates: 空结果 → items=[], meta.total=0", async () => {
    const da = createDataAccess([], 0);
    const result = await listReviewCandidates("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    assert.equal(result.items.length, 0);
    assert.equal(result.meta.total, 0);
    assert.equal(result.meta.totalPages, 1); // 至少 1 页
    assert.equal(result.meta.page, 1);
    assert.equal(result.meta.pageSize, 20);
  });

  // ── listReviewCandidates: 正常列表 ───────────────────────
  test("listReviewCandidates: 返回正确映射的 items", async () => {
    const rows = [
      createRow({ id: "c1" }),
      createRow({ id: "c2", editedText: "编辑后" }),
    ];
    const da = createDataAccess(rows, 2);
    const result = await listReviewCandidates("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]!.candidate.id, "c1");
    assert.equal(result.items[1]!.displayText, "编辑后");
  });

  // ── listReviewCandidates: 分页 meta ──────────────────────
  test("listReviewCandidates: 分页 meta 正确计算", async () => {
    const da = createDataAccess([], 55);
    const result = await listReviewCandidates("shop-1", {
      page: 2,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    assert.equal(result.meta.total, 55);
    assert.equal(result.meta.page, 2);
    assert.equal(result.meta.pageSize, 20);
    assert.equal(result.meta.totalPages, 3); // ceil(55/20) = 3
  });

  test("listReviewCandidates: 分页 skip/take 传递正确", async () => {
    const capture: { skip?: number; take?: number } = {};
    const da = createDataAccess([], 0, capture);
    await listReviewCandidates("shop-1", {
      page: 3,
      pageSize: 10,
      sortBy: "createdAt",
    }, da);

    assert.equal(capture.skip, 20); // (3-1)*10
    assert.equal(capture.take, 10);
  });

  test("listReviewCandidates: 最后一页 total 正确", async () => {
    const da = createDataAccess([], 20);
    const result = await listReviewCandidates("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    assert.equal(result.meta.totalPages, 1);
  });

  test("listReviewCandidates: 余数页 totalPages 向上取整", async () => {
    const da = createDataAccess([], 21);
    const result = await listReviewCandidates("shop-1", {
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    assert.equal(result.meta.totalPages, 2); // ceil(21/20) = 2
  });

  // ── listReviewCandidates: 筛选传递 ───────────────────────
  test("listReviewCandidates: status 筛选传递到 where", async () => {
    const capture: { where?: unknown } = {};
    const da = createDataAccess([], 0, capture);
    await listReviewCandidates("shop-1", {
      status: AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
      page: 1,
      pageSize: 20,
      sortBy: "createdAt",
    }, da);

    const where = capture.where as { status: { in: string[] } };
    assert.deepEqual(where.status.in, [AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE]);
  });

  // 等待所有异步测试完成
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.log(`\n  共 ${passed + failed} 项，通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
