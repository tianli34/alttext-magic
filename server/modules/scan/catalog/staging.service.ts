/**
 * File: server/modules/scan/catalog/staging.service.ts
 * Purpose: 通用批量 flush 组件 — 将流式解析器产出的 staging 行批量写入数据库。
 *
 * 职责:
 * - 接收 parser 产出的 staging 行（带 shopId + scanTaskAttemptId）
 * - 按 staging 表类型分发写入
 * - 使用 Prisma createMany 批量插入
 * - 跳过唯一约束冲突（ON CONFLICT DO NOTHING 策略）
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import type {
  StgArticleRow,
  StgCollectionRow,
  StgMediaImageFileRow,
  StgProductRow,
  StgMediaImageProductRow,
  ProductMediaFlushItem,
} from "./parsers/staging.types";

const logger = createLogger({ module: "staging-service" });

/* ------------------------------------------------------------------ */
/*  Article staging flush                                               */
/* ------------------------------------------------------------------ */

/**
 * 批量写入 stg_article 表。
 */
export async function flushArticleStaging(
  shopId: string,
  scanTaskAttemptId: string,
  rows: StgArticleRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await prisma.stgArticle.createMany({
    data: rows.map((row) => ({
      shopId,
      scanTaskAttemptId,
      articleId: row.articleId,
      title: row.title,
      handle: row.handle,
      imageAltText: row.imageAltText,
      imageUrl: row.imageUrl,
    })),
    skipDuplicates: true,
  });

  logger.debug(
    { shopId, scanTaskAttemptId, count: result.count, inputCount: rows.length },
    "staging.article.flushed",
  );

  return result.count;
}

/* ------------------------------------------------------------------ */
/*  Collection staging flush                                            */
/* ------------------------------------------------------------------ */

/**
 * 批量写入 stg_collection 表。
 */
export async function flushCollectionStaging(
  shopId: string,
  scanTaskAttemptId: string,
  rows: StgCollectionRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await prisma.stgCollection.createMany({
    data: rows.map((row) => ({
      shopId,
      scanTaskAttemptId,
      collectionId: row.collectionId,
      title: row.title,
      handle: row.handle,
      imageAltText: row.imageAltText,
      imageUrl: row.imageUrl,
    })),
    skipDuplicates: true,
  });

  logger.debug(
    { shopId, scanTaskAttemptId, count: result.count, inputCount: rows.length },
    "staging.collection.flushed",
  );

  return result.count;
}

/* ------------------------------------------------------------------ */
/*  Files staging flush                                                 */
/* ------------------------------------------------------------------ */

/**
 * 批量写入 stg_media_image_file 表。
 */
export async function flushMediaFileStaging(
  shopId: string,
  scanTaskAttemptId: string,
  rows: StgMediaImageFileRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await prisma.stgMediaImageFile.createMany({
    data: rows.map((row) => ({
      shopId,
      scanTaskAttemptId,
      mediaImageId: row.mediaImageId,
      alt: row.alt,
      url: row.url,
    })),
    skipDuplicates: true,
  });

  logger.debug(
    { shopId, scanTaskAttemptId, count: result.count, inputCount: rows.length },
    "staging.media-file.flushed",
  );

  return result.count;
}

/* ------------------------------------------------------------------ */
/*  Product-Media staging flush（含 __parentId 分发）                    */
/* ------------------------------------------------------------------ */

/**
 * 批量写入 stg_product + stg_media_image_product 表。
 * 按 kind 字段分发到不同的 staging 表。
 */
export async function flushProductMediaStaging(
  shopId: string,
  scanTaskAttemptId: string,
  items: ProductMediaFlushItem[],
): Promise<{ productCount: number; mediaCount: number }> {
  if (items.length === 0) return { productCount: 0, mediaCount: 0 };

  // 按 kind 分组
  const products: StgProductRow[] = [];
  const mediaImages: StgMediaImageProductRow[] = [];

  for (const item of items) {
    if (item.kind === "product") {
      products.push(item.data);
    } else if (item.kind === "media") {
      mediaImages.push(item.data);
    }
  }

  // 并行写入两个表
  const [productResult, mediaResult] = await Promise.all([
    products.length > 0
      ? prisma.stgProduct.createMany({
          data: products.map((row) => ({
            shopId,
            scanTaskAttemptId,
            productId: row.productId,
            title: row.title,
            handle: row.handle,
          })),
          skipDuplicates: true,
        })
      : { count: 0 },
    mediaImages.length > 0
      ? prisma.stgMediaImageProduct.createMany({
          data: mediaImages.map((row) => ({
            shopId,
            scanTaskAttemptId,
            mediaImageId: row.mediaImageId,
            parentProductId: row.parentProductId,
            alt: row.alt,
            url: row.url,
            positionIndex: row.positionIndex,
          })),
          skipDuplicates: true,
        })
      : { count: 0 },
  ]);

  logger.debug(
    {
      shopId,
      scanTaskAttemptId,
      productCount: productResult.count,
      mediaCount: mediaResult.count,
      inputCount: items.length,
    },
    "staging.product-media.flushed",
  );

  return {
    productCount: productResult.count,
    mediaCount: mediaResult.count,
  };
}

/* ------------------------------------------------------------------ */
/*  Staging 行计数查询                                                   */
/* ------------------------------------------------------------------ */

/**
 * 查询指定 attempt 已写入的 staging 行总数（用于更新 parsedRows）。
 */
export async function countStagingRows(
  scanTaskAttemptId: string,
  resourceType: string,
): Promise<number> {
  switch (resourceType) {
    case "ARTICLE_IMAGE":
      return prisma.stgArticle.count({
        where: { scanTaskAttemptId },
      });
    case "COLLECTION_IMAGE":
      return prisma.stgCollection.count({
        where: { scanTaskAttemptId },
      });
    case "FILES":
      return prisma.stgMediaImageFile.count({
        where: { scanTaskAttemptId },
      });
    case "PRODUCT_MEDIA": {
      const [products, media] = await Promise.all([
        prisma.stgProduct.count({ where: { scanTaskAttemptId } }),
        prisma.stgMediaImageProduct.count({
          where: { scanTaskAttemptId },
        }),
      ]);
      return products + media;
    }
    default:
      logger.warn({ resourceType }, "staging.unknown-resource-type");
      return 0;
  }
}
