/**
 * File: server/modules/dashboard/dashboard.service.ts
 * Purpose: Dashboard 聚合服务 —— 基于已发布的 candidate_group_projection
 *          返回当前 effective_read_scope_flags 内的分组统计。
 */
import { CandidateGroupType, Prisma, ScanJobStatus } from "@prisma/client";
import {
  listEnabledScopeFlags,
  normalizeScopeFlagState,
} from "../../../app/lib/scope-utils";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
import { computeEffectiveReadScopeFlags } from "../shop/scope.service";
import type { ScanScopeFlags } from "../shop/shop.types";
import type { DashboardData, DashboardGroupStats } from "./dashboard.types";

const logger = createLogger({ module: "dashboard-service" });

interface DashboardShopRow {
  scanScopeFlags: unknown;
  lastPublishedScopeFlags: unknown;
  lastPublishedAt: Date | null;
}

interface DashboardGroupStatsRow {
  groupType: CandidateGroupType;
  total: number;
  hasAlt: number;
  missing: number;
  decorative: number;
}

export interface DashboardDataAccess {
  getShop(shopId: string): Promise<DashboardShopRow | null>;
  getGroupStats(
    shopId: string,
    allowedGroups: readonly CandidateGroupType[],
  ): Promise<DashboardGroupStatsRow[]>;
  /** 返回运行中扫描的 scanJobId，无则 null */
  getActiveScanJobId(shopId: string): Promise<string | null>;
}

const scopeFlagToGroupType: Record<keyof ScanScopeFlags, CandidateGroupType> = {
  PRODUCT_MEDIA: CandidateGroupType.PRODUCT_MEDIA,
  FILES: CandidateGroupType.FILES,
  COLLECTION_IMAGE: CandidateGroupType.COLLECTION,
  ARTICLE_IMAGE: CandidateGroupType.ARTICLE,
};

export function mapScopeFlagsToGroupTypes(
  effectiveReadScopeFlags: ScanScopeFlags,
): CandidateGroupType[] {
  return listEnabledScopeFlags(effectiveReadScopeFlags).map(
    (flag) => scopeFlagToGroupType[flag],
  );
}

export function buildDashboardGroupStatsQuery(
  shopId: string,
  allowedGroups: readonly CandidateGroupType[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      cgp.group_type AS "groupType",
      COUNT(*)::integer AS "total",
      COUNT(*) FILTER (
        WHERE alt_target.current_alt_empty = false
      )::integer AS "hasAlt",
      COUNT(*) FILTER (
        WHERE alt_target.current_alt_empty = true
          AND COALESCE(decorative_mark.is_active, false) = false
      )::integer AS "missing",
      COUNT(*) FILTER (
        WHERE decorative_mark.is_active = true
      )::integer AS "decorative"
    FROM candidate_group_projection AS cgp
    JOIN alt_target AS alt_target
      ON alt_target.id = cgp.alt_target_id
      AND alt_target.shop_id = cgp.shop_id
    LEFT JOIN decorative_mark AS decorative_mark
      ON decorative_mark.alt_target_id = cgp.alt_target_id
      AND decorative_mark.shop_id = cgp.shop_id
      AND decorative_mark.is_active = true
    WHERE cgp.shop_id = ${shopId}
      AND cgp.group_type = ANY(ARRAY[${Prisma.join(allowedGroups)}]::"CandidateGroupType"[])
    GROUP BY cgp.group_type
    ORDER BY cgp.group_type
  `;
}

const prismaDashboardDataAccess: DashboardDataAccess = {
  async getShop(shopId) {
    return prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        scanScopeFlags: true,
        lastPublishedScopeFlags: true,
        lastPublishedAt: true,
      },
    });
  },

  async getGroupStats(shopId, allowedGroups) {
    if (allowedGroups.length === 0) {
      return [];
    }

    return prisma.$queryRaw<DashboardGroupStatsRow[]>(
      buildDashboardGroupStatsQuery(shopId, allowedGroups),
    );
  },

  async getActiveScanJobId(shopId) {
    const runningJob = await prisma.scanJob.findFirst({
      where: {
        shopId,
        status: ScanJobStatus.RUNNING,
      },
      select: { id: true },
      orderBy: { startedAt: "desc" },
    });

    return runningJob?.id ?? null;
  },
};

function normalizeGroupStatsRows(
  rows: readonly DashboardGroupStatsRow[],
): DashboardGroupStats[] {
  return rows.map((row) => ({
    groupType: row.groupType,
    total: Number(row.total),
    hasAlt: Number(row.hasAlt),
    missing: Number(row.missing),
    decorative: Number(row.decorative),
  }));
}

export async function getDashboardData(
  shopId: string,
  dataAccess: DashboardDataAccess = prismaDashboardDataAccess,
): Promise<DashboardData> {
  const shop = await dataAccess.getShop(shopId);

  if (!shop) {
    logger.warn({ shopId }, "Shop not found, returning empty dashboard data");
    return {
      groups: [],
      lastPublishedAt: null,
      isScanning: false,
      activeScanJobId: null,
    };
  }

  const scanScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );
  const allowedGroups = mapScopeFlagsToGroupTypes(effectiveReadScopeFlags);

  // [DEBUG] 诊断日志：追踪 scope flag 决策链
  logger.info(
    {
      shopId,
      scanScopeFlags,
      lastPublishedScopeFlags,
      effectiveReadScopeFlags,
      allowedGroups,
      lastPublishedAt: shop.lastPublishedAt?.toISOString() ?? null,
    },
    "dashboard.scope-flags-debug",
  );

  const [groupRows, activeScanJobId] = await Promise.all([
    dataAccess.getGroupStats(shopId, allowedGroups),
    dataAccess.getActiveScanJobId(shopId),
  ]);

  // [DEBUG] 诊断日志：追踪分组统计结果
  logger.info(
    {
      shopId,
      groupTypes: groupRows.map((r) => ({ groupType: r.groupType, total: r.total })),
      activeScanJobId,
    },
    "dashboard.group-stats-debug",
  );

  return {
    groups: normalizeGroupStatsRows(groupRows),
    lastPublishedAt: shop.lastPublishedAt
      ? shop.lastPublishedAt.toISOString()
      : null,
    isScanning: activeScanJobId !== null,
    activeScanJobId,
  };
}
