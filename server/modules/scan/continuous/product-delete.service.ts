/**
 * File: server/modules/scan/continuous/product-delete.service.ts
 * Purpose: 处理 products/delete webhook —— 商品删除后对已发布层执行空收敛。
 * 复用 convergeProduct(mediaImages: []) 将该商品下所有 imageUsage / altTarget / altCandidate 收敛为 NOT_FOUND，
 * 并清理指纹记录，实现删除的秒级感知（无需等待下次全量扫描或增量更新）。
 */
import { ImageUsageType, type Prisma } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { convergeProduct } from "../productConvergence";
import { createLogger } from "../../../utils/logger";
import { recordMetric } from "../../../../shared/logger/metrics";

const logger = createLogger({ module: "product-delete" });

/** products/delete 事件中商品 ID 的固定前缀 */
const PRODUCT_GID_PREFIX = "gid://shopify/Product/";

/**
 * 处理商品删除 Webhook 事件。
 *
 * 流程:
 * 1. 从 payload 提取商品 GID（payload 仅含 { "id": "gid://shopify/Product/xxx" }）
 * 2. 解析 shopId（由 shopDomain 查询）
 * 3. 前置检查: 该商品在 DB 中是否已有 PRODUCT 引用 —— 没有则跳过（从未被扫描/跟踪过）
 * 4. 事务内空收敛: usages / targets → NOT_FOUND，candidate / projection 重算
 * 5. 清理该商品指纹记录，避免陈旧指纹导致后续增量扫描被误跳过
 *
 * 幂等性: 与全量扫描 sweep、增量 update 收敛共用同一收敛原语，重复执行无副作用。
 */
export async function handleProductDeletedWebhook(params: {
  shopDomain: string;
  payload: unknown;
}): Promise<void> {
  const { shopDomain, payload } = params;

  // 1. 提取商品 GID
  const rawId = extractProductId(payload);
  if (!rawId) {
    logger.warn({ shopDomain }, "product-delete.invalid_payload");
    return;
  }
  const productId = rawId;

  // 2. 解析 shopId
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) {
    logger.warn(
      { shopDomain, productId },
      "product-delete.shop_not_found",
    );
    return;
  }
  const shopId = shop.id;

  // 3. 前置检查: 该商品是否已被应用跟踪（存在 PRODUCT 引用）
  const trackedUsageCount = await prisma.imageUsage.count({
    where: {
      shopId,
      usageType: ImageUsageType.PRODUCT,
      usageId: productId,
    },
  });
  if (trackedUsageCount === 0) {
    logger.info(
      { shopDomain, shopId, productId },
      "product-delete.no_tracked_usages_skipped",
    );
    return;
  }

  // 4. 事务内空收敛 + 清理指纹
  const convergeResult = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const result = await convergeProduct(tx, {
        shopId,
        productId,
        mediaImages: [],
      });

      // 5. 清理指纹记录（商品已删，指纹失去意义且可能造成未来误跳过）
      await tx.resourceImageFingerprint.deleteMany({
        where: {
          shopId,
          resourceType: "PRODUCT",
          resourceId: productId,
        },
      });

      return result;
    },
  );

  recordMetric("webhook.product_delete.converged", 1, {
    shop_domain: shopDomain,
    product_id: productId,
    target_count: convergeResult.publishedTargetCount,
    usage_count: convergeResult.publishedUsageCount,
    candidate_count: convergeResult.candidateCount,
  });

  logger.info(
    {
      shopDomain,
      shopId,
      productId,
      convergeResult,
    },
    "product-delete.converged",
  );
}

/**
 * 从 webhook payload 中提取商品 GID。
 * products/delete 的 payload 仅包含 { "id": "gid://shopify/Product/xxx" }。
 */
function extractProductId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "string" && id.startsWith(PRODUCT_GID_PREFIX)) {
    return id;
  }
  return null;
}
