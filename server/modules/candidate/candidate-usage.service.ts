/**
 * File: server/modules/candidate/candidate-usage.service.ts
 * Purpose: 候选 Usage 详情查询服务 —— 返回指定候选的所有 PRESENT usage 位置，
 *          按 effective scope 过滤 out-of-scope 的 usage。
 */
import {
  CandidateGroupType,
  ImageUsageType,
  PresentStatus,
} from "@prisma/client";
import {
  normalizeScopeFlagState,
  type ScopeFlagState,
} from "../../../app/lib/scope-utils";
import prisma from "../../db/prisma.server";
import { computeEffectiveReadScopeFlags } from "../shop/scope.service";
import type { ScanScopeFlags } from "../shop/shop.types";

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/** 单条 usage 详情 */
export interface UsageDetail {
  /** 使用类型（PRODUCT / FILE / COLLECTION / ARTICLE 等） */
  usageType: string;
  /** Shopify 资源 GID */
  usageId: string;
  /** 资源标题 */
  title: string | null;
  /** 资源 handle */
  handle: string | null;
  /** 图片位置索引 */
  positionIndex: number | null;
  /** 当前 alt text（来自 alt_target） */
  currentAlt: string | null;
  /** Shopify Admin 跳转链接 */
  shopifyAdminUrl: string;
}

/** API 响应 */
export interface UsageListResponse {
  usages: UsageDetail[];
}

/* ------------------------------------------------------------------ */
/*  数据访问接口                                                       */
/* ------------------------------------------------------------------ */

export interface UsageDetailCandidateRow {
  altTargetId: string;
  currentAlt: string | null;
  /** alt_target 的 presentStatus 是否为 PRESENT */
  targetPresent: boolean;
}

export interface UsageDetailShopRow {
  shopDomain: string;
  scanScopeFlags: unknown;
  lastPublishedScopeFlags: unknown;
}

export interface UsageDetailUsageRow {
  usageType: string;
  usageId: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
}

export interface UsageDetailProjectionRow {
  groupType: string;
  primaryUsageType: string;
  primaryUsageId: string;
  primaryTitle: string | null;
  primaryHandle: string | null;
}

export interface UsageDetailDataAccess {
  getCandidate(
    shopId: string,
    altCandidateId: string,
  ): Promise<UsageDetailCandidateRow | null>;

  getShop(shopId: string): Promise<UsageDetailShopRow | null>;

  getUsages(altTargetId: string): Promise<UsageDetailUsageRow[]>;

  getProjection(
    altCandidateId: string,
  ): Promise<UsageDetailProjectionRow | null>;
}

/* ------------------------------------------------------------------ */
/*  常量与映射                                                         */
/* ------------------------------------------------------------------ */

/** usageType → scope flag 映射 */
const USAGE_TYPE_TO_SCOPE_FLAG: Record<ImageUsageType, keyof ScopeFlagState> = {
  PRODUCT: "PRODUCT_MEDIA",
  FILE: "FILES",
};

/** CandidateGroupType → usageType 映射（仅 PRODUCT_MEDIA / FILES 有对应 usageType） */
function groupToUsageType(
  group: CandidateGroupType,
): ImageUsageType | null {
  switch (group) {
    case CandidateGroupType.PRODUCT_MEDIA:
      return ImageUsageType.PRODUCT;
    case CandidateGroupType.FILES:
      return ImageUsageType.FILE;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从 Shopify GID 中提取数字 ID。
 * gid://shopify/Product/123 → 123
 */
function extractNumericId(gid: string): string {
  const segments = gid.split("/");
  return segments[segments.length - 1];
}

/**
 * 拼接 Shopify Admin 资源跳转链接。
 */
export function buildShopifyAdminUrl(
  shopDomain: string,
  usageType: string,
  usageId: string,
): string {
  const numericId = extractNumericId(usageId);

  if (usageType === "PRODUCT" || usageId.startsWith("gid://shopify/Product/")) {
    return `https://${shopDomain}/admin/products/${numericId}`;
  }
  if (usageId.startsWith("gid://shopify/Collection/")) {
    return `https://${shopDomain}/admin/collections/${numericId}`;
  }
  if (usageId.startsWith("gid://shopify/Article/")) {
    return `https://${shopDomain}/admin/articles/${numericId}`;
  }
  return `https://${shopDomain}/admin/settings/files`;
}

/* ------------------------------------------------------------------ */
/*  Prisma 数据访问实现                                                */
/* ------------------------------------------------------------------ */

const prismaUsageDetailDataAccess: UsageDetailDataAccess = {
  async getCandidate(shopId, altCandidateId) {
    const candidate = await prisma.altCandidate.findFirst({
      where: { id: altCandidateId, shopId },
      select: {
        altTargetId: true,
        altTarget: {
          select: {
            currentAltText: true,
            presentStatus: true,
          },
        },
      },
    });

    if (!candidate) return null;

    return {
      altTargetId: candidate.altTargetId,
      currentAlt: candidate.altTarget.currentAltText,
      targetPresent: candidate.altTarget.presentStatus === PresentStatus.PRESENT,
    };
  },

  async getShop(shopId) {
    return prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        shopDomain: true,
        scanScopeFlags: true,
        lastPublishedScopeFlags: true,
      },
    });
  },

  async getUsages(altTargetId) {
    return prisma.imageUsage.findMany({
      where: {
        altTargetId,
        presentStatus: PresentStatus.PRESENT,
      },
      select: {
        usageType: true,
        usageId: true,
        title: true,
        handle: true,
        positionIndex: true,
      },
      orderBy: [
        { usageType: "asc" },
        { positionIndex: "asc" },
        { usageId: "asc" },
      ],
    });
  },

  async getProjection(altCandidateId) {
    return prisma.candidateGroupProjection.findFirst({
      where: { altCandidateId },
      select: {
        groupType: true,
        primaryUsageType: true,
        primaryUsageId: true,
        primaryTitle: true,
        primaryHandle: true,
      },
    });
  },
};

/* ------------------------------------------------------------------ */
/*  服务函数                                                           */
/* ------------------------------------------------------------------ */

/**
 * 获取指定候选的所有 PRESENT usage，过滤 out-of-scope。
 *
 * @param shopId - 当前 shop 的内部 ID
 * @param altCandidateId - 候选 ID
 * @param groupFilter - 可选的 group 过滤（CandidateGroupType）
 * @param dataAccess - 数据访问层（可注入用于测试）
 */
export async function listCandidateUsages(
  shopId: string,
  altCandidateId: string,
  groupFilter?: CandidateGroupType,
  dataAccess: UsageDetailDataAccess = prismaUsageDetailDataAccess,
): Promise<UsageListResponse> {
  // 1. 校验候选归属当前 shop
  const candidate = await dataAccess.getCandidate(shopId, altCandidateId);
  if (!candidate) {
    return { usages: [] };
  }

  // 2. 若 alt_target 已不存在，返回空列表
  if (!candidate.targetPresent) {
    return { usages: [] };
  }

  // 3. 获取 shop 信息（含 scope）
  const shop = await dataAccess.getShop(shopId);
  if (!shop) {
    return { usages: [] };
  }

  // 4. 计算 effective read scope
  const scanScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );

  // 5. 查询所有 PRESENT usage
  const usageRows = await dataAccess.getUsages(candidate.altTargetId);

  // 6. 按 effective scope 过滤（仅 ImageUsageType 已知类型参与过滤）
  const scopeFiltered = usageRows.filter((usage) => {
    const scopeFlag = USAGE_TYPE_TO_SCOPE_FLAG[usage.usageType as ImageUsageType];
    return scopeFlag ? effectiveReadScopeFlags[scopeFlag] : true;
  });

  // 7. 可选 group 过滤
  let finalUsages = scopeFiltered;
  if (groupFilter) {
    const targetUsageType = groupToUsageType(groupFilter);
    if (targetUsageType === null) {
      // COLLECTION / ARTICLE 无 image_usage 记录
      finalUsages = [];
    } else {
      finalUsages = scopeFiltered.filter(
        (usage) => usage.usageType === targetUsageType,
      );
    }
  }

  // 7.5. 若最终 usages 为空，查询 projection 补充 SELF 自引用
  // （COLLECTION / ARTICLE 无 ImageUsage 记录，但自身位置也是"影响范围"）
  if (finalUsages.length === 0) {
    const projection = await dataAccess.getProjection(altCandidateId);
    if (projection && projection.primaryUsageType === "SELF") {
      finalUsages = [
        {
          usageType: projection.groupType,
          usageId: projection.primaryUsageId,
          title: null,
          handle: null,
          positionIndex: null,
        },
      ];
    }
  }

  // 8. 构建响应
  return {
    usages: finalUsages.map((usage) => ({
      usageType: usage.usageType,
      usageId: usage.usageId,
      title: usage.title,
      handle: usage.handle,
      positionIndex: usage.positionIndex,
      currentAlt: candidate.currentAlt,
      shopifyAdminUrl: buildShopifyAdminUrl(
        shop.shopDomain,
        usage.usageType,
        usage.usageId,
      ),
    })),
  };
}
