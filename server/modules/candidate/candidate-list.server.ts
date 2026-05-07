/**
 * File: server/modules/candidate/candidate-list.server.ts
 * Purpose: 候选列表查询服务，统一处理 effective scope、状态过滤与游标分页。
 */
import {
  AltCandidateStatus,
  CandidateGroupType,
  Prisma,
  type AltDraftContextMode,
  type CandidateGroupPrimaryUsageType,
} from "@prisma/client";
import {
  normalizeScopeFlagState,
  type ScopeFlagState,
} from "../../../app/lib/scope-utils";
import prisma from "../../db/prisma.server";
import { computeEffectiveReadScopeFlags } from "../shop/scope.service";
import type { ScanScopeFlags } from "../shop/shop.types";
import { mapScopeFlagsToGroupTypes } from "../dashboard/dashboard.service";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const candidateListStatusValues = [
  "MISSING",
  "HAS_ALT",
  "DECORATIVE_SKIPPED",
  "GENERATION_FAILED_RETRYABLE",
  "GENERATED",
  "WRITEBACK_FAILED_RETRYABLE",
  "WRITTEN",
  "RESOLVED",
  "NOT_FOUND",
  "SKIPPED_ALREADY_FILLED",
] as const;

export type CandidateListStatus = (typeof candidateListStatusValues)[number];

export interface CandidateListQuery {
  group?: CandidateGroupType;
  status?: CandidateListStatus;
  cursor?: string;
  limit?: number;
}

export interface CandidatePrimaryUsage {
  type: CandidateGroupPrimaryUsageType;
  id: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
}

export interface CandidateListItem {
  id: string;
  altCandidateId: string;
  thumbnailUrl: string | null;
  groupType: CandidateGroupType;
  primaryUsage: CandidatePrimaryUsage;
  additionalUsageCount: number;
  usageCountPresent: number;
  contextMode: AltDraftContextMode | null;
  status: CandidateListStatus;
  currentAlt: string | null;
  draftAlt: string | null;
  impactScopeSummary: Prisma.JsonValue;
}

export interface CandidateListResponse {
  items: CandidateListItem[];
  nextCursor: string | null;
}

interface CandidateListShopRow {
  scanScopeFlags: unknown;
  lastPublishedScopeFlags: unknown;
}

export interface CandidateListRow {
  id: string;
  altCandidateId: string;
  thumbnailUrl: string | null;
  groupType: CandidateGroupType;
  primaryUsageType: CandidateGroupPrimaryUsageType;
  primaryUsageId: string;
  primaryTitle: string | null;
  primaryHandle: string | null;
  primaryPositionIndex: number | null;
  additionalUsageCount: number;
  usageCountPresent: number;
  impactScopeSummary: Prisma.JsonValue;
  contextMode: AltDraftContextMode | null;
  candidateStatus: AltCandidateStatus;
  currentAltEmpty: boolean;
  decorativeActive: boolean;
  currentAlt: string | null;
  draftAlt: string | null;
}

export interface CandidateListDataAccess {
  getShop(shopId: string): Promise<CandidateListShopRow | null>;
  getRows(
    shopId: string,
    groups: readonly CandidateGroupType[],
    query: Required<Pick<CandidateListQuery, "limit">> &
      Pick<CandidateListQuery, "cursor" | "status">,
  ): Promise<CandidateListRow[]>;
}

const prismaCandidateListDataAccess: CandidateListDataAccess = {
  async getShop(shopId) {
    return prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        scanScopeFlags: true,
        lastPublishedScopeFlags: true,
      },
    });
  },

  async getRows(shopId, groups, query) {
    return prisma.$queryRaw<CandidateListRow[]>(
      buildCandidateListQuery(shopId, groups, query),
    );
  },
};

export function normalizeCandidateListLimit(input: number | undefined): number {
  if (input === undefined) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(input, 1), MAX_LIMIT);
}

export function isCandidateListStatus(
  value: string,
): value is CandidateListStatus {
  return candidateListStatusValues.some((status) => status === value);
}

export function isCandidateGroupType(value: string): value is CandidateGroupType {
  return Object.values(CandidateGroupType).some((group) => group === value);
}

function mapGroupToScopeFlag(group: CandidateGroupType): keyof ScopeFlagState {
  switch (group) {
    case CandidateGroupType.PRODUCT_MEDIA:
      return "PRODUCT_MEDIA";
    case CandidateGroupType.FILES:
      return "FILES";
    case CandidateGroupType.COLLECTION:
      return "COLLECTION_IMAGE";
    case CandidateGroupType.ARTICLE:
      return "ARTICLE_IMAGE";
  }
}

function deriveStatus(row: CandidateListRow): CandidateListStatus {
  if (row.decorativeActive) {
    return "DECORATIVE_SKIPPED";
  }

  if (!row.currentAltEmpty) {
    return "HAS_ALT";
  }

  return row.candidateStatus;
}

function buildStatusCondition(status: CandidateListStatus | undefined): Prisma.Sql {
  if (!status) {
    return Prisma.empty;
  }

  if (status === "MISSING") {
    return Prisma.sql`
      AND alt_target.current_alt_empty = true
      AND COALESCE(decorative_mark.is_active, false) = false
    `;
  }

  if (status === "HAS_ALT") {
    return Prisma.sql`
      AND alt_target.current_alt_empty = false
      AND COALESCE(decorative_mark.is_active, false) = false
    `;
  }

  if (status === "DECORATIVE_SKIPPED") {
    return Prisma.sql`
      AND decorative_mark.is_active = true
    `;
  }

  return Prisma.sql`
    AND alt_candidate.status = ${status}::"AltCandidateStatus"
    AND COALESCE(decorative_mark.is_active, false) = false
  `;
}

export function buildCandidateListQuery(
  shopId: string,
  groups: readonly CandidateGroupType[],
  query: Required<Pick<CandidateListQuery, "limit">> &
    Pick<CandidateListQuery, "cursor" | "status">,
): Prisma.Sql {
  const cursorCondition = query.cursor
    ? Prisma.sql`AND cgp.id > ${query.cursor}`
    : Prisma.empty;
  const statusCondition = buildStatusCondition(query.status);

  return Prisma.sql`
    SELECT
      cgp.id AS "id",
      cgp.alt_candidate_id AS "altCandidateId",
      alt_target.preview_url AS "thumbnailUrl",
      cgp.group_type AS "groupType",
      cgp.primary_usage_type AS "primaryUsageType",
      cgp.primary_usage_id AS "primaryUsageId",
      cgp.primary_title AS "primaryTitle",
      cgp.primary_handle AS "primaryHandle",
      cgp.primary_position_index AS "primaryPositionIndex",
      cgp.additional_usage_count AS "additionalUsageCount",
      cgp.usage_count_present AS "usageCountPresent",
      cgp.impact_scope_summary AS "impactScopeSummary",
      alt_draft.context_mode AS "contextMode",
      alt_candidate.status AS "candidateStatus",
      alt_target.current_alt_empty AS "currentAltEmpty",
      COALESCE(decorative_mark.is_active, false) AS "decorativeActive",
      alt_target.current_alt_text AS "currentAlt",
      COALESCE(
        alt_draft.final_text,
        alt_draft.edited_text,
        alt_draft.generated_text
      ) AS "draftAlt"
    FROM candidate_group_projection AS cgp
    LEFT JOIN alt_candidate AS alt_candidate
      ON alt_candidate.id = cgp.alt_candidate_id
      AND alt_candidate.shop_id = cgp.shop_id
    LEFT JOIN alt_target AS alt_target
      ON alt_target.id = cgp.alt_target_id
      AND alt_target.shop_id = cgp.shop_id
    LEFT JOIN alt_draft AS alt_draft
      ON alt_draft.alt_candidate_id = cgp.alt_candidate_id
      AND alt_draft.shop_id = cgp.shop_id
    LEFT JOIN decorative_mark AS decorative_mark
      ON decorative_mark.alt_target_id = cgp.alt_target_id
      AND decorative_mark.shop_id = cgp.shop_id
      AND decorative_mark.is_active = true
    WHERE cgp.shop_id = ${shopId}
      AND cgp.group_type = ANY(ARRAY[${Prisma.join(groups)}]::"CandidateGroupType"[])
      ${cursorCondition}
      ${statusCondition}
    ORDER BY cgp.id ASC
    LIMIT ${query.limit + 1}
  `;
}

function normalizeRows(
  rows: readonly CandidateListRow[],
  limit: number,
): CandidateListResponse {
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    items: pageRows.map((row) => ({
      id: row.id,
      altCandidateId: row.altCandidateId,
      thumbnailUrl: row.thumbnailUrl,
      groupType: row.groupType,
      primaryUsage: {
        type: row.primaryUsageType,
        id: row.primaryUsageId,
        title: row.primaryTitle,
        handle: row.primaryHandle,
        positionIndex: row.primaryPositionIndex,
      },
      additionalUsageCount: Number(row.additionalUsageCount),
      usageCountPresent: Number(row.usageCountPresent),
      contextMode: row.contextMode,
      status: deriveStatus(row),
      currentAlt: row.currentAlt,
      draftAlt: row.draftAlt,
      impactScopeSummary: row.impactScopeSummary,
    })),
    nextCursor: hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null,
  };
}

export async function listCandidates(
  shopId: string,
  query: CandidateListQuery,
  dataAccess: CandidateListDataAccess = prismaCandidateListDataAccess,
): Promise<CandidateListResponse> {
  const shop = await dataAccess.getShop(shopId);
  const limit = normalizeCandidateListLimit(query.limit);

  if (!shop) {
    return { items: [], nextCursor: null };
  }

  const scanScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );

  if (query.group) {
    const scopeFlag = mapGroupToScopeFlag(query.group);
    if (!effectiveReadScopeFlags[scopeFlag]) {
      return { items: [], nextCursor: null };
    }
  }

  const groups = query.group
    ? [query.group]
    : mapScopeFlagsToGroupTypes(effectiveReadScopeFlags);

  if (groups.length === 0) {
    return { items: [], nextCursor: null };
  }

  const rows = await dataAccess.getRows(shopId, groups, {
    cursor: query.cursor,
    status: query.status,
    limit,
  });

  return normalizeRows(rows, limit);
}
