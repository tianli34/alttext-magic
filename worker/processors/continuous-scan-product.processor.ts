/**
 * File: worker/processors/continuous-scan-product.processor.ts
 * Purpose: continuous_scan_product job 处理器。
 *          处理单个 Product 的增量扫描逻辑。
 */

import type { Job } from "bullmq";
import { Session } from "@shopify/shopify-api";
import { decryptToken } from "../../server/crypto/token-encryption";
import prisma from "../../server/db/prisma.server";
import { delayJobForLock } from "../../server/services/gates/lockGate";
import { checkIncrementalEnabled } from "../../server/services/gates/planGate";
import { checkScopeForTopic } from "../../server/services/gates/scopeGate";
import { checkFingerprintChange } from "../../server/services/gates/fingerprintGate";
import { getProductMedia } from "../../server/shopify/queries/getProductMedia";
import { computeProductFingerprint } from "../../server/modules/fingerprint/imageFingerprint";
import { convergeProduct } from "../../server/modules/scan/productConvergence";
import {
  markProcessing,
  markProcessed,
  markSkipped,
  markFailed,
} from "../../server/modules/scan/continuous/webhook-event.service";
import { createLogger } from "../../server/utils/logger";
import { recordMetric } from "../../shared/logger/metrics";
import type { ContinuousScanProductPayload } from "../../server/queues/continuous-scan.types";

const logger = createLogger({ module: "continuous-scan-product-processor" });

/**
 * 运行 continuous_scan_product Job。
 *
 * @param job BullMQ Job 实例
 */
export async function processContinuousScanProductJob(
  job: Job<ContinuousScanProductPayload>,
): Promise<void> {
  const { shopId, productId, latestWebhookEventId } = job.data;

  logger.info(
    { shopId, productId, latestWebhookEventId, jobId: job.id },
    "continuous-scan-product.processor.start",
  );

  // 1. Gate 1：lockGate 校验全量扫描锁
  const lockResult = await delayJobForLock(job);
  if (lockResult.delayed || lockResult.exceeded) {
    logger.info(
      {
        shopId,
        productId,
        latestWebhookEventId,
        delayed: lockResult.delayed,
        exceeded: lockResult.exceeded,
      },
      "continuous-scan-product.processor.lock_gate_blocked",
    );
    recordMetric("incremental.skip.lock_gate", 1, { shop_domain: shopId });
    return;
  }

  try {
    // 2. 将 WebhookEvent 标记为 PROCESSING 并记录开始处理时间
    await markProcessing(latestWebhookEventId);

    // 3. Gate 2：planGate 校验增量扫描权限
    const planEnabled = await checkIncrementalEnabled(shopId);
    if (!planEnabled) {
      logger.info(
        { shopId, latestWebhookEventId },
        "continuous-scan-product.processor.skipped_plan",
      );
      recordMetric("incremental.skip.plan", 1, { shop_domain: shopId });
      await markSkipped(latestWebhookEventId, "PLAN");
      return;
    }

    // 4. Gate 3：scopeGate 校验产品更新 scope 是否开启
    const scopeEnabled = await checkScopeForTopic(shopId, "products/update");
    if (!scopeEnabled) {
      logger.info(
        { shopId, latestWebhookEventId },
        "continuous-scan-product.processor.skipped_scope",
      );
      recordMetric("incremental.skip.scope", 1, { shop_domain: shopId });
      await markSkipped(latestWebhookEventId, "SCOPE");
      return;
    }

    // 5. 载入 shop 凭证并建立 Shopify Session
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        shopDomain: true,
        accessTokenEncrypted: true,
        accessTokenNonce: true,
        accessTokenTag: true,
        scopes: true,
      },
    });
    if (!shop) {
      throw new Error(`[产品增量扫描] 店铺记录不存在: ${shopId}`);
    }

    const session = new Session({
      id: `offline_${shop.shopDomain}`,
      shop: shop.shopDomain,
      state: "",
      isOnline: false,
      scope: shop.scopes ?? undefined,
      accessToken: decryptToken(
        shop.accessTokenEncrypted,
        shop.accessTokenNonce,
        shop.accessTokenTag,
      ),
    });

    // 6. 调用 8-D1 API 读取当前 product media
    const mediaImages = await getProductMedia({
      session,
      shopifyGid: productId,
    });

    // 7. 计算图片指纹并转换输入格式 (8-A3)
    const mediaInput = mediaImages.map((m) => ({
      id: m.id,
      alt: m.alt,
      imageUrl: m.url,
    }));
    const fp = computeProductFingerprint(mediaInput);

    // 8. Gate 4：fingerprintGate 校验图片指纹是否变化 (8-C5)
    const fingerprintResult = await checkFingerprintChange(
      shopId,
      "PRODUCT",
      productId,
      fp,
    );
    if (fingerprintResult === "UNCHANGED") {
      logger.info(
        { shopId, productId, latestWebhookEventId },
        "continuous-scan-product.processor.skipped_no_image_change",
      );
      recordMetric("incremental.skip.no_image_change", 1, { shop_domain: shopId });
      await markSkipped(latestWebhookEventId, "NO_IMAGE_CHANGE");
      return;
    }

    // 9. 开启数据库事务，整合收敛动作与指纹更新 (8-D2 / 8-A4)
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // 级联同步写入已发布层（不触碰任何待发布草稿状态）
      await convergeProduct(tx, {
        shopId,
        productId,
        mediaImages,
      });

      // 覆盖/插入指纹记录
      await tx.resourceImageFingerprint.upsert({
        where: {
          shopId_resourceType_resourceId: {
            shopId,
            resourceType: "PRODUCT",
            resourceId: productId,
          },
        },
        create: {
          shopId,
          resourceType: "PRODUCT",
          resourceId: productId,
          fingerprintHash: fp,
          lastProcessedWebhookId: latestWebhookEventId,
          lastProcessedAt: now,
        },
        update: {
          fingerprintHash: fp,
          lastProcessedWebhookId: latestWebhookEventId,
          lastProcessedAt: now,
        },
      });
    });

    // 10. WebhookEvent 标记为 PROCESSED，完成全部操作
    await markProcessed(latestWebhookEventId);

    logger.info(
      { shopId, productId, latestWebhookEventId },
      "continuous-scan-product.processor.success",
    );
  } catch (error) {
    logger.error(
      { shopId, productId, latestWebhookEventId, err: error },
      "continuous-scan-product.processor.failed",
    );

    // 异常处理：更新为 FAILED 并记录错误消息
    await markFailed(latestWebhookEventId, error);

    // 重新抛出以触发 BullMQ 自动指数退避重试
    throw error;
  }
}
