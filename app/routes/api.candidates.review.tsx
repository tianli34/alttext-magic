/**
 * File: app/routes/api.candidates.review.tsx
 * Purpose: GET /api/candidates/review —— 审阅列表接口，支持筛选与分页。
 *
 * Query 参数：
 *   status   : GENERATED | WRITEBACK_FAILED_RETRYABLE（默认两者都返回）
 *   altPlane : FILE_ALT | COLLECTION_IMAGE_ALT | ARTICLE_IMAGE_ALT（可选）
 *   page     : 页码（默认 1）
 *   pageSize : 每页条数（默认 20，上限 50）
 *   sortBy   : createdAt（默认）| altPlane
 */
import { AltCandidateStatus, AltPlane } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  REVIEW_VISIBLE_STATUSES,
  REVIEW_SORT_FIELDS,
  normalizePage,
  normalizePageSize,
  listReviewCandidates,
  type ReviewSortField,
  type ReviewVisibleStatus,
} from "../../server/modules/candidate/review-list.server";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.candidates.review" });

/** Zod schema：校验 query 参数 */
const querySchema = z.object({
  status: z
    .enum(REVIEW_VISIBLE_STATUSES as unknown as [string, ...string[]])
    .optional(),
  altPlane: z.nativeEnum(AltPlane).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
  sortBy: z
    .enum(REVIEW_SORT_FIELDS as unknown as [string, ...string[]])
    .optional(),
});

/** 将 Zod 错误转换为前端友好格式 */
function issuesFromZod(
  error: ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 仅允许 GET
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 2. 解析并校验 query 参数
  let parsed: z.infer<typeof querySchema>;
  try {
    const url = new URL(request.url);
    parsed = querySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      altPlane: url.searchParams.get("altPlane") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      sortBy: url.searchParams.get("sortBy") ?? undefined,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: "Invalid query", issues: issuesFromZod(err) },
        { status: 400 },
      );
    }
    throw err;
  }

  // 3. Session 鉴权
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for review list");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 构建查询参数并调用服务
  const data = await listReviewCandidates(shop.id, {
    status: parsed.status as ReviewVisibleStatus | undefined,
    altPlane: parsed.altPlane,
    page: normalizePage(parsed.page),
    pageSize: normalizePageSize(parsed.pageSize),
    sortBy: (parsed.sortBy ?? "createdAt") as ReviewSortField,
  });

  return Response.json(data);
};
