/**
 * File: server/modules/scan/collectionConvergence.ts
 * Purpose: 提供针对单个 Collection (系列) 及其封面图的 Target/Candidate/Projection 收敛更新纯函数
 *
 * 与 productConvergence.ts 形成对称结构。
 * Collection 没有 ImageUsage (图片引用) 记录，Target 即 SELF (自身引用)。
 * 供全量扫描发布流程 (publish.service.ts) 和未来的增量扫描流程共同复用。
 */

import { AltPlane, PresentStatus, Prisma } from "@prisma/client";
import {
  computeNextCandidateState,
  rebuildTargetProjections,
} from "./catalog/publish.service";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "collection-convergence" });

// ============================================================
// 类型定义
// ============================================================

/** Collection 封面图信息；若封面图不存在则传 null */
export interface ConvergeCollectionImage {
  /** 图片的 URL (图片下载链接) */
  url: string;
  /** 图片的 altText (Alt 描述文本)，可为 null */
  alt: string | null;
}

export interface ConvergeCollectionInput {
  /** shopId (商铺 ID) */
  shopId: string;
  /** collectionId (系列 ID)，对应 Shopify 的 gid://shopify/Collection/xxxx，也是 writeTargetId */
  collectionId: string;
  /** 封面图信息；若系列无封面图则传 null，会将对应 AltTarget 标记为 NOT_FOUND (不存在) */
  image: ConvergeCollectionImage | null;
  /** 可选的 collectionTitle (系列标题) */
  collectionTitle?: string | null;
  /** 可选的 collectionHandle (系列句柄/别名) */
  collectionHandle?: string | null;
  /** 可选的 scanJobId (扫描任务 ID) */
  scanJobId?: string;
}

export interface ConvergeCollectionResult {
  /** target 是否被更新/新建 */
  upserted: boolean;
  /** candidate (备选 Alt) 数量 */
  candidateCount: number;
  /** projection (投影) 数量 */
  projectionCount: number;
}

// ============================================================
// 主函数
// ============================================================

/**
 * 针对单个 Collection (系列) 及其封面图，在 Transaction (数据库事务) 内进行收敛更新。
 *
 * 调用方需在外层 prisma.$transaction 中调用此函数，并将 tx 传入。
 */
export async function convergeCollection(
  tx: Prisma.TransactionClient,
  input: ConvergeCollectionInput
): Promise<ConvergeCollectionResult> {
  const now = new Date();

  const result: ConvergeCollectionResult = {
    upserted: false,
    candidateCount: 0,
    projectionCount: 0,
  };

  // 1. 自动寻回补全或者获取有效的 scanJobId (扫描任务 ID)
  let scanJobId = input.scanJobId ?? null;
  if (!scanJobId) {
    const shop = await tx.shop.findUnique({
      where: { id: input.shopId },
      select: { lastPublishedScanJobId: true },
    });
    scanJobId = shop?.lastPublishedScanJobId ?? null;
  }
  if (!scanJobId) {
    const anyJob = await tx.scanJob.findFirst({
      where: { shopId: input.shopId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    scanJobId = anyJob?.id ?? null;
  }
  if (!scanJobId) {
    throw new Error(
      `[收敛失败] 找不到店铺 ${input.shopId} 对应的 ScanJob (扫描任务)，convergeCollection 中止`
    );
  }

  // 2. 自动补全 Collection 的 title (标题) 和 handle (别名句柄)
  //    防止增量同步时元数据被覆盖为 null
  let displayTitle = input.collectionTitle ?? null;
  let displayHandle = input.collectionHandle ?? null;

  if (!displayTitle || !displayHandle) {
    const existingTarget = await tx.altTarget.findUnique({
      where: {
        shopId_altPlane_writeTargetId_locale: {
          shopId: input.shopId,
          altPlane: AltPlane.COLLECTION_IMAGE_ALT,
          writeTargetId: input.collectionId,
          locale: "default",
        },
      },
      select: {
        displayTitle: true,
        displayHandle: true,
      },
    });
    if (existingTarget) {
      displayTitle = displayTitle ?? existingTarget.displayTitle;
      displayHandle = displayHandle ?? existingTarget.displayHandle;
    }
  }

  // 3. 判断 image 是否存在，决定 presentStatus (存在状态)
  const hasImage = input.image !== null && input.image.url.length > 0;
  const presentStatus: PresentStatus = hasImage
    ? PresentStatus.PRESENT
    : PresentStatus.NOT_FOUND;

  // 4. Upsert COLLECTION_IMAGE_ALT AltTarget (更新或插入系列 Alt 目标实体)
  const altTarget = await tx.altTarget.upsert({
    where: {
      shopId_altPlane_writeTargetId_locale: {
        shopId: input.shopId,
        altPlane: AltPlane.COLLECTION_IMAGE_ALT,
        writeTargetId: input.collectionId,
        locale: "default",
      },
    },
    create: {
      shopId: input.shopId,
      altPlane: AltPlane.COLLECTION_IMAGE_ALT,
      writeTargetId: input.collectionId,
      locale: "default",
      displayTitle,
      displayHandle,
      previewUrl: input.image?.url ?? null,
      currentAltText: input.image?.alt ?? null,
      currentAltEmpty:
        !hasImage || input.image?.alt === null || input.image?.alt === "",
      lastPublishedScanJobId: scanJobId,
      lastSeenAt: now,
      presentStatus,
    },
    update: {
      displayTitle,
      displayHandle,
      previewUrl: input.image?.url ?? null,
      currentAltText: input.image?.alt ?? null,
      currentAltEmpty:
        !hasImage || input.image?.alt === null || input.image?.alt === "",
      lastPublishedScanJobId: scanJobId,
      lastSeenAt: now,
      presentStatus,
    },
    select: {
      id: true,
      altPlane: true,
      writeTargetId: true,
      displayTitle: true,
      displayHandle: true,
      currentAltEmpty: true,
      presentStatus: true,
      decorativeMark: {
        select: {
          isActive: true,
        },
      },
      altCandidate: {
        select: {
          id: true,
          status: true,
          draft: {
            select: {
              expiresAt: true,
            },
          },
        },
      },
    },
  });

  result.upserted = true;

  // 5. 重算 / upsert alt_candidate (重算并更新插入备选 Alt)
  const nextCandidate = computeNextCandidateState({ target: altTarget, now });

  const candidate = await tx.altCandidate.upsert({
    where: {
      altTargetId: altTarget.id,
    },
    create: {
      shopId: input.shopId,
      altTargetId: altTarget.id,
      status: nextCandidate.status,
      missingReason: nextCandidate.missingReason,
      riskFlags: [],
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenScanJobId: scanJobId,
    },
    update: {
      status: nextCandidate.status,
      missingReason: nextCandidate.missingReason,
      lastSeenAt: now,
      lastSeenScanJobId: scanJobId,
    },
    select: {
      id: true,
    },
  });

  result.candidateCount = 1;

  // 6. 重建 candidate_group_projection (重建候选人组投影)
  //    Collection 没有 ImageUsage 记录，传入空的 presentUsages (存在的引用数组)
  //    rebuildTargetProjections 内部会根据 presentStatus 决定 upsert 还是 delete 投影记录
  const projectionCount = await rebuildTargetProjections(tx, {
    shopId: input.shopId,
    scanJobId,
    target: altTarget,
    altCandidateId: candidate.id,
    presentUsages: [],
  });

  result.projectionCount = projectionCount;

  logger.info(
    {
      shopId: input.shopId,
      collectionId: input.collectionId,
      hasImage,
      presentStatus,
      candidateStatus: nextCandidate.status,
      projectionCount,
    },
    "converge-collection.success"
  );

  return result;
}
