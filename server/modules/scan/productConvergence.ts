/**
 * File: server/modules/scan/productConvergence.ts
 * Purpose: 提供针对单个 Product 及其 MediaImages 的 Target/Usage/Candidate/Projection 收敛更新纯函数
 */

import {
  AltPlane,
  ImageUsageType,
  PresentStatus,
  Prisma
} from "@prisma/client";
import {
  computeNextCandidateState,
  rebuildTargetProjections
} from "./catalog/publish.service";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "product-convergence" });

export interface ConvergeMediaImage {
  id: string; // mediaImageId (媒体图片标识)，对应 Shopify 的 gid://shopify/MediaImage/xxxx，也是 alt_target.writeTargetId
  alt: string | null; // 媒体图片的 altText (Alt 文本描述)
  url: string; // 媒体图片的 url (原始图片下载链接)
  positionIndex?: number; // 可选的位置索引，代表图片在产品中的展示次序
}

export interface ConvergeProductInput {
  shopId: string; // shopId (商铺 ID)
  productId: string; // productId (产品 ID)，对应 Shopify 的 gid://shopify/Product/xxxx
  mediaImages: ConvergeMediaImage[]; // mediaImages (最新的产品图片媒体列表)
  productTitle?: string | null; // 可选的产品 title (产品标题)，如果不传将自动寻回补全
  productHandle?: string | null; // 可选的产品 handle (产品句柄/别名)，如果不传将自动寻回补全
  scanJobId?: string; // 可选的 scanJobId (发布扫描任务 ID)
}

export interface ConvergeProductResult {
  publishedTargetCount: number; // 发布成功的 target 数量
  publishedUsageCount: number; // 发布成功的 usage 数量
  candidateCount: number; // 备选 alt 数量
  projectionCount: number; // 投影数量
}

/**
 * 针对单个 Product 及其最新的 MediaImage 列表，在 Transaction (数据库事务) 内进行收敛更新
 */
export async function convergeProduct(
  tx: Prisma.TransactionClient,
  input: ConvergeProductInput
): Promise<ConvergeProductResult> {
  const now = new Date();

  const result: ConvergeProductResult = {
    publishedTargetCount: 0,
    publishedUsageCount: 0,
    candidateCount: 0,
    projectionCount: 0
  };

  // 1. 自动寻回补全或者获取有效的 scanJobId (发布扫描任务 ID)
  let scanJobId = input.scanJobId || null;
  if (!scanJobId) {
    const shop = await tx.shop.findUnique({
      where: { id: input.shopId },
      select: { lastPublishedScanJobId: true }
    });
    scanJobId = shop?.lastPublishedScanJobId || null;
  }
  if (!scanJobId) {
    const anyJob = await tx.scanJob.findFirst({
      where: { shopId: input.shopId },
      select: { id: true }
    });
    scanJobId = anyJob?.id || null;
  }
  if (!scanJobId) {
    throw new Error(`[收敛失败] 找不到店铺 ${input.shopId} 对应的 ScanJob (扫描任务)，收敛动作被迫中止`);
  }

  // 2. 自动补全产品的 title (标题) 和 handle (别名句柄)，防止元数据在增量同步时被覆盖为 null
  let title = input.productTitle ?? null;
  let handle = input.productHandle ?? null;

  if (!title || !handle) {
    const existingUsage = await tx.imageUsage.findFirst({
      where: {
        shopId: input.shopId,
        usageType: "PRODUCT",
        usageId: input.productId,
        OR: [
          { title: { not: null } },
          { handle: { not: null } }
        ]
      },
      select: {
        title: true,
        handle: true
      }
    });
    if (existingUsage) {
      title = title ?? existingUsage.title;
      handle = handle ?? existingUsage.handle;
    }
  }

  // 3. Upsert FILE_ALT Target (更新/插入文件 Alt 目标实体)
  const altTargetIdByWriteTargetId = new Map<string, string>();
  for (const image of input.mediaImages) {
    const target = await tx.altTarget.upsert({
      where: {
        shopId_altPlane_writeTargetId_locale: {
          shopId: input.shopId,
          altPlane: AltPlane.FILE_ALT,
          writeTargetId: image.id,
          locale: "default"
        }
      },
      create: {
        shopId: input.shopId,
        altPlane: AltPlane.FILE_ALT,
        writeTargetId: image.id,
        locale: "default",
        displayTitle: title, // 首创时选用当前产品标题作为 displayTitle
        displayHandle: handle,
        previewUrl: image.url,
        currentAltText: image.alt,
        currentAltEmpty: image.alt === null || image.alt === "",
        lastPublishedScanJobId: scanJobId,
        lastSeenAt: now,
        presentStatus: PresentStatus.PRESENT
      },
      update: {
        previewUrl: image.url,
        currentAltText: image.alt,
        currentAltEmpty: image.alt === null || image.alt === "",
        lastPublishedScanJobId: scanJobId,
        lastSeenAt: now,
        presentStatus: PresentStatus.PRESENT
      },
      select: {
        id: true
      }
    });
    altTargetIdByWriteTargetId.set(image.id, target.id);
    result.publishedTargetCount += 1;
  }

  // 4. Upsert Image Usage for PRODUCT (更新/插入产品类型图片引用关系)
  let index = 0;
  for (const image of input.mediaImages) {
    const altTargetId = altTargetIdByWriteTargetId.get(image.id);
    if (!altTargetId) {
      continue;
    }

    const positionIndex = image.positionIndex !== undefined ? image.positionIndex : index;
    index++;

    await tx.imageUsage.upsert({
      where: {
        shopId_altTargetId_usageType_usageId: {
          shopId: input.shopId,
          altTargetId,
          usageType: ImageUsageType.PRODUCT,
          usageId: input.productId
        }
      },
      create: {
        shopId: input.shopId,
        altTargetId,
        usageType: ImageUsageType.PRODUCT,
        usageId: input.productId,
        title,
        handle,
        positionIndex,
        lastPublishedScanJobId: scanJobId,
        lastSeenAt: now,
        lastSeenScanJobId: scanJobId,
        presentStatus: PresentStatus.PRESENT
      },
      update: {
        title,
        handle,
        positionIndex,
        lastPublishedScanJobId: scanJobId,
        lastSeenAt: now,
        lastSeenScanJobId: scanJobId,
        presentStatus: PresentStatus.PRESENT
      }
    });
    result.publishedUsageCount += 1;
  }

  // 5. Sweep (陈旧引用关系清理)
  // 找出当前产品在数据库中已有但不再包含在最新 mediaImages 列表里的 usages
  const existingUsages = await tx.imageUsage.findMany({
    where: {
      shopId: input.shopId,
      usageType: ImageUsageType.PRODUCT,
      usageId: input.productId
    },
    select: {
      id: true,
      altTargetId: true
    }
  });

  const currentAltTargetIds = new Set(Array.from(altTargetIdByWriteTargetId.values()));
  const usagesToSweep = existingUsages.filter(
    (u) => !currentAltTargetIds.has(u.altTargetId)
  );

  const sweptTargetIds = new Set<string>();
  if (usagesToSweep.length > 0) {
    await tx.imageUsage.updateMany({
      where: {
        id: { in: usagesToSweep.map((u) => u.id) }
      },
      data: {
        presentStatus: PresentStatus.NOT_FOUND,
        lastPublishedScanJobId: scanJobId
      }
    });
    usagesToSweep.forEach((u) => sweptTargetIds.add(u.altTargetId));
  }

  const impactedTargetIds = new Set<string>([
    ...Array.from(currentAltTargetIds),
    ...Array.from(sweptTargetIds)
  ]);

  if (impactedTargetIds.size === 0) {
    return result;
  }

  const impactedTargetIdList = Array.from(impactedTargetIds);

  // 6. 重算每个相关 Target 的 present_status (当前存在状态)
  const allUsages = await tx.imageUsage.findMany({
    where: {
      altTargetId: { in: impactedTargetIdList },
      usageType: { in: [ImageUsageType.PRODUCT, ImageUsageType.FILE] }
    },
    select: {
      altTargetId: true,
      presentStatus: true
    }
  });

  const hasPresentByTargetId = new Map<string, boolean>();
  for (const usage of allUsages) {
    if (usage.presentStatus === PresentStatus.PRESENT) {
      hasPresentByTargetId.set(usage.altTargetId, true);
    } else if (!hasPresentByTargetId.has(usage.altTargetId)) {
      hasPresentByTargetId.set(usage.altTargetId, false);
    }
  }

  for (const targetId of impactedTargetIdList) {
    const isPresent = hasPresentByTargetId.get(targetId) || false;
    await tx.altTarget.update({
      where: { id: targetId },
      data: {
        presentStatus: isPresent ? PresentStatus.PRESENT : PresentStatus.NOT_FOUND,
        lastPublishedScanJobId: scanJobId
      }
    });
  }

  // 7. 重算 / upsert alt_candidate (重算并更新插入备选 Alt)
  const impactedTargets = await tx.altTarget.findMany({
    where: {
      id: { in: impactedTargetIdList }
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
          isActive: true
        }
      },
      altCandidate: {
        select: {
          id: true,
          status: true,
          draft: {
            select: {
              expiresAt: true
            }
          }
        }
      }
    }
  });

  const candidateByTargetId = new Map<string, string>();
  for (const target of impactedTargets) {
    const nextCandidate = computeNextCandidateState({
      target,
      now
    });
    const candidate = await tx.altCandidate.upsert({
      where: {
        altTargetId: target.id
      },
      create: {
        shopId: input.shopId,
        altTargetId: target.id,
        status: nextCandidate.status,
        missingReason: nextCandidate.missingReason,
        riskFlags: [],
        firstSeenAt: now,
        lastSeenAt: now,
        lastSeenScanJobId: scanJobId
      },
      update: {
        status: nextCandidate.status,
        missingReason: nextCandidate.missingReason,
        lastSeenAt: now,
        lastSeenScanJobId: scanJobId
      },
      select: {
        id: true
      }
    });
    candidateByTargetId.set(target.id, candidate.id);
    result.candidateCount += 1;
  }

  // 8. 重建 candidate_group_projection (重建候选人组投影)
  const presentUsages = await tx.imageUsage.findMany({
    where: {
      altTargetId: { in: impactedTargetIdList },
      presentStatus: PresentStatus.PRESENT
    },
    select: {
      altTargetId: true,
      usageType: true,
      usageId: true,
      title: true,
      handle: true,
      positionIndex: true
    },
    orderBy: [
      { usageType: "asc" },
      { positionIndex: "asc" },
      { usageId: "asc" }
    ]
  });

  const usagesByTargetId = new Map<string, typeof presentUsages>();
  for (const usage of presentUsages) {
    const list = usagesByTargetId.get(usage.altTargetId) || [];
    list.push(usage);
    usagesByTargetId.set(usage.altTargetId, list);
  }

  for (const target of impactedTargets) {
    const altCandidateId = candidateByTargetId.get(target.id);
    if (!altCandidateId) {
      continue;
    }

    const count = await rebuildTargetProjections(tx, {
      shopId: input.shopId,
      scanJobId,
      target,
      altCandidateId,
      presentUsages: usagesByTargetId.get(target.id) ?? []
    });
    result.projectionCount += count;
  }

  logger.info(
    {
      shopId: input.shopId,
      productId: input.productId,
      mediaCount: input.mediaImages.length,
      impactedCount: impactedTargetIdList.length,
      counts: result
    },
    "converge-product.success"
  );

  return result;
}
