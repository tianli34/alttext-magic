/**
 * File: worker/processors/continuous-scan-collection.processor.ts
 * Purpose: continuous_scan_collection job 处理器。
 *          处理单个 Collection 的增量扫描逻辑。
 */

import type { Job } from "bullmq";
import { Session } from "@shopify/shopify-api";
import { decryptToken } from "../../server/crypto/token-encryption";
import prisma from "../../server/db/prisma.server";
import { delayJobForLock } from "../../server/services/gates/lockGate";
import { checkIncrementalEnabled } from "../../server/services/gates/planGate";
import { checkScopeForTopic } from "../../server/services/gates/scopeGate";
import { checkFingerprintChange } from "../../server/services/gates/fingerprintGate";
import { getCollectionImage } from "../../server/shopify/queries/getCollectionImage";
import { computeCollectionFingerprint } from "../../server/modules/fingerprint/imageFingerprint";
import { convergeCollection } from "../../server/modules/scan/collectionConvergence";
import {
  markProcessing,
  markProcessed,
  markSkipped,
  markFailed,
} from "../../server/modules/scan/continuous/webhook-event.service";
import { createLogger } from "../../server/utils/logger";
import type { ContinuousScanCollectionPayload } from "../../server/queues/continuous-scan.types";

const logger = createLogger({ module: "continuous-scan-collection-processor" });

/**
 * 运行 continuous_scan_collection Job。
 *
 * @param job BullMQ Job 实例
 */
export async function processContinuousScanCollectionJob(
  job: Job<ContinuousScanCollectionPayload>,
): Promise<void> {
  const { shopId, collectionId, latestWebhookEventId } = job.data;

  logger.info(
    { shopId, collectionId, latestWebhookEventId, jobId: job.id },
    "continuous-scan-collection.processor.start",
  );

  // 1. Gate 1：lockGate 校验全量扫描锁
  const lockResult = await delayJobForLock(job);
  if (lockResult.delayed || lockResult.exceeded) {
    logger.info(
      {
        shopId,
        collectionId,
        latestWebhookEventId,
        delayed: lockResult.delayed,
        exceeded: lockResult.exceeded,
      },
      "continuous-scan-collection.processor.lock_gate_blocked",
    );
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
        "continuous-scan-collection.processor.skipped_plan",
      );
      await markSkipped(latestWebhookEventId, "PLAN");
      return;
    }

    // 4. Gate 3：scopeGate 校验集合更新 scope 是否开启 (collections/update → COLLECTION_IMAGE)
    const scopeEnabled = await checkScopeForTopic(shopId, "collections/update");
    if (!scopeEnabled) {
      logger.info(
        { shopId, latestWebhookEventId },
        "continuous-scan-collection.processor.skipped_scope",
      );
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
      throw new Error(`[集合增量扫描] 店铺记录不存在: ${shopId}`);
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

    // 6. 调用 8-E1 API 读取当前 collection 封面图
    const collectionImage = await getCollectionImage({
      session,
      shopifyGid: collectionId,
    });

    // 7. 计算图片指纹 (8-A3)
    const fp = computeCollectionFingerprint(
      collectionImage ? { url: collectionImage.url, altText: collectionImage.altText } : null,
    );

    // 8. Gate 4：fingerprintGate 校验图片指纹是否变化 (8-C5)
    const fingerprintResult = await checkFingerprintChange(
      shopId,
      "COLLECTION",
      collectionId,
      fp,
    );
    if (fingerprintResult === "UNCHANGED") {
      logger.info(
        { shopId, collectionId, latestWebhookEventId },
        "continuous-scan-collection.processor.skipped_no_image_change",
      );
      await markSkipped(latestWebhookEventId, "NO_IMAGE_CHANGE");
      return;
    }

    // 9. 开启数据库事务，整合收敛动作与指纹更新 (8-E2 / 8-A4)
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // 级联同步写入已发布层（不触碰任何待发布草稿状态）
      await convergeCollection(tx, {
        shopId,
        collectionId,
        image: collectionImage
          ? { url: collectionImage.url, alt: collectionImage.altText }
          : null,
      });

      // 覆盖/插入指纹记录
      await tx.resourceImageFingerprint.upsert({
        where: {
          shopId_resourceType_resourceId: {
            shopId,
            resourceType: "COLLECTION",
            resourceId: collectionId,
          },
        },
        create: {
          shopId,
          resourceType: "COLLECTION",
          resourceId: collectionId,
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
      { shopId, collectionId, latestWebhookEventId },
      "continuous-scan-collection.processor.success",
    );
  } catch (error) {
    logger.error(
      { shopId, collectionId, latestWebhookEventId, err: error },
      "continuous-scan-collection.processor.failed",
    );

    // 异常处理：更新为 FAILED 并记录错误消息
    await markFailed(latestWebhookEventId, error);

    // 重新抛出以触发 BullMQ 自动指数退避重试
    throw error;
  }
}
