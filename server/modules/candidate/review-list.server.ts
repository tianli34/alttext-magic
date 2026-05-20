/**
 * File: server/modules/candidate/review-list.server.ts
 * Purpose: 审阅列表查询服务，支持状态/altPlane 筛选与 offset 分页。
 *
 * 查询对象：status ∈ { GENERATED, WRITEBACK_FAILED_RETRYABLE } 的候选，
 * 关联 AltTarget、AltDraft、CandidateGroupProjection 返回审阅所需的完整数据。
 */
import {
  AltCandidateStatus,
  AltPlane,
  JobItemStatus,
  type CandidateGroupPrimaryUsageType,
  type Prisma,
} from "@prisma/client";
import prisma from "../../db/prisma.server";

/** 审阅可见的状态集合 */
export const REVIEW_VISIBLE_STATUSES = [
  AltCandidateStatus.GENERATED,
  AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
] as const;

export type ReviewVisibleStatus = (typeof REVIEW_VISIBLE_STATUSES)[number];

/** 排序字段 */
export const REVIEW_SORT_FIELDS = ["createdAt", "altPlane"] as const;
export type ReviewSortField = (typeof REVIEW_SORT_FIELDS)[number];

/** 默认分页参数 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// ─── 请求参数 ───────────────────────────────────────────────

export interface ReviewListQuery {
  /** 筛选状态，默认返回全部 REVIEW_VISIBLE */
  status?: ReviewVisibleStatus;
  /** 筛选 altPlane */
  altPlane?: AltPlane;
  /** 页码（从 1 开始） */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 排序字段 */
  sortBy: ReviewSortField;
}

// ─── 响应类型 ───────────────────────────────────────────────

export interface ReviewCandidateField {
  id: string;
  status: AltCandidateStatus;
  altPlane: AltPlane;
  isDecorative: boolean;
  errorMessage: string | null;
  retryCount: number;
}

export interface ReviewTargetField {
  shopifyGid: string;
  thumbnailUrl: string | null;
  currentAltText: string | null;
  primaryUsage: {
    type: CandidateGroupPrimaryUsageType;
    id: string;
    title: string | null;
    handle: string | null;
    positionIndex: number | null;
  } | null;
  usageCountPresent: number;
}

export interface ReviewDraftField {
  aiGeneratedText: string;
  editedText: string | null;
  modelUsed: string;
  createdAt: Date;
}

export interface ReviewListItem {
  candidate: ReviewCandidateField;
  target: ReviewTargetField;
  draft: ReviewDraftField | null;
  displayText: string;
  isSharedFile: boolean;
}

export interface ReviewListMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ReviewListResponse {
  items: ReviewListItem[];
  meta: ReviewListMeta;
}

// ─── 数据访问层抽象 ─────────────────────────────────────────

/** Prisma 查询返回的原始行类型 */
export interface ReviewRawRow {
  id: string;
  status: AltCandidateStatus;
  errorMessage: string | null;
  retryCount: number;
  altPlane: AltPlane;
  isDecorative: boolean;
  shopifyGid: string;
  thumbnailUrl: string | null;
  currentAltText: string | null;
  primaryUsageType: CandidateGroupPrimaryUsageType | null;
  primaryUsageId: string | null;
  primaryTitle: string | null;
  primaryHandle: string | null;
  primaryPositionIndex: number | null;
  usageCountPresent: number;
  aiGeneratedText: string | null;
  editedText: string | null;
  modelUsed: string | null;
  draftCreatedAt: Date | null;
}

export interface ReviewListDataAccess {
  getCandidates(
    shopId: string,
    where: Prisma.AltCandidateWhereInput,
    orderBy: Prisma.AltCandidateOrderByWithRelationInput,
    skip: number,
    take: number,
  ): Promise<ReviewRawRow[]>;
  getCount(shopId: string, where: Prisma.AltCandidateWhereInput): Promise<number>;
}

// ─── 工具函数 ───────────────────────────────────────────────

/** 将 pageSize 限制在 [1, MAX_PAGE_SIZE] */
export function normalizePageSize(input: number | undefined): number {
  if (input === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(input, 1), MAX_PAGE_SIZE);
}

/** 将页码限制在 ≥ 1 */
export function normalizePage(input: number | undefined): number {
  if (input === undefined) return 1;
  return Math.max(input, 1);
}

/** 构建 where 条件 */
export function buildReviewWhere(
  shopId: string,
  query: ReviewListQuery,
): Prisma.AltCandidateWhereInput {
  const where: Prisma.AltCandidateWhereInput = {
    shopId,
    status: {
      in: query.status
        ? [query.status]
        : [...REVIEW_VISIBLE_STATUSES],
    },
  };

  if (query.altPlane) {
    where.altTarget = { altPlane: query.altPlane };
  }

  return where;
}

/** 构建 orderBy */
export function buildReviewOrderBy(
  sortBy: ReviewSortField,
): Prisma.AltCandidateOrderByWithRelationInput {
  if (sortBy === "altPlane") {
    return { altTarget: { altPlane: "asc" } };
  }
  return { createdAt: "desc" };
}

/** 将 Prisma 原始行转换为 API 响应项 */
export function mapRowToItem(row: ReviewRawRow): ReviewListItem {
  const aiGeneratedText = row.aiGeneratedText ?? "";
  const displayText = row.editedText?.trim() || aiGeneratedText;

  return {
    candidate: {
      id: row.id,
      status: row.status,
      altPlane: row.altPlane,
      isDecorative: row.isDecorative,
      errorMessage: row.errorMessage,
      retryCount: row.retryCount,
    },
    target: {
      shopifyGid: row.shopifyGid,
      thumbnailUrl: row.thumbnailUrl,
      currentAltText: row.currentAltText,
      primaryUsage:
        row.primaryUsageId !== null
          ? {
              type: row.primaryUsageType!,
              id: row.primaryUsageId,
              title: row.primaryTitle,
              handle: row.primaryHandle,
              positionIndex: row.primaryPositionIndex,
            }
          : null,
      usageCountPresent: row.usageCountPresent,
    },
    draft: row.aiGeneratedText !== null
      ? {
          aiGeneratedText,
          editedText: row.editedText,
          modelUsed: row.modelUsed ?? "",
          createdAt: row.draftCreatedAt!,
        }
      : null,
    displayText,
    isSharedFile: row.usageCountPresent > 1,
  };
}

// ─── Prisma 数据访问实现 ────────────────────────────────────

const prismaDataAccess: ReviewListDataAccess = {
  async getCandidates(shopId, where, orderBy, skip, take) {
    const candidates = await prisma.altCandidate.findMany({
      where,
      orderBy,
      skip,
      take,
      select: {
        id: true,
        status: true,
        errorMessage: true,
        _count: {
          select: {
            jobItems: {
              where: { status: JobItemStatus.FAILED },
            },
          },
        },
        altTarget: {
          select: {
            altPlane: true,
            writeTargetId: true,
            previewUrl: true,
            currentAltText: true,
            decorativeMark: {
              where: { isActive: true },
              select: { id: true },
            },
            groupProjections: {
              take: 1,
              orderBy: { id: "asc" },
              select: {
                primaryUsageType: true,
                primaryUsageId: true,
                primaryTitle: true,
                primaryHandle: true,
                primaryPositionIndex: true,
                usageCountPresent: true,
              },
            },
          },
        },
        draft: {
          select: {
            generatedText: true,
            editedText: true,
            modelUsed: true,
            createdAt: true,
          },
        },
      },
    });

    return candidates.map((c) => {
      const target = c.altTarget;
      const projection = target.groupProjections[0];
      return {
        id: c.id,
        status: c.status,
        errorMessage: c.errorMessage,
        retryCount: c._count.jobItems,
        altPlane: target.altPlane,
        isDecorative: target.decorativeMark !== null,
        shopifyGid: target.writeTargetId,
        thumbnailUrl: target.previewUrl,
        currentAltText: target.currentAltText,
        primaryUsageType: projection?.primaryUsageType ?? null,
        primaryUsageId: projection?.primaryUsageId ?? null,
        primaryTitle: projection?.primaryTitle ?? null,
        primaryHandle: projection?.primaryHandle ?? null,
        primaryPositionIndex: projection?.primaryPositionIndex ?? null,
        usageCountPresent: projection?.usageCountPresent ?? 0,
        aiGeneratedText: c.draft?.generatedText ?? null,
        editedText: c.draft?.editedText ?? null,
        modelUsed: c.draft?.modelUsed ?? null,
        draftCreatedAt: c.draft?.createdAt ?? null,
      } satisfies ReviewRawRow;
    });
  },

  async getCount(shopId, where) {
    return prisma.altCandidate.count({ where });
  },
};

// ─── 主查询入口 ─────────────────────────────────────────────

/**
 * 查询审阅列表，支持筛选、排序与分页。
 * @param shopId - 当前店铺 ID
 * @param query  - 查询参数
 * @param dataAccess - 数据访问层（可注入，便于测试）
 */
export async function listReviewCandidates(
  shopId: string,
  query: ReviewListQuery,
  dataAccess: ReviewListDataAccess = prismaDataAccess,
): Promise<ReviewListResponse> {
  const where = buildReviewWhere(shopId, query);
  const orderBy = buildReviewOrderBy(query.sortBy);
  const skip = (query.page - 1) * query.pageSize;

  const [rows, total] = await Promise.all([
    dataAccess.getCandidates(shopId, where, orderBy, skip, query.pageSize),
    dataAccess.getCount(shopId, where),
  ]);

  const totalPages = Math.max(Math.ceil(total / query.pageSize), 1);

  return {
    items: rows.map(mapRowToItem),
    meta: {
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages,
    },
  };
}
