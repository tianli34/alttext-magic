/**
 * File: worker/processors/continuous-scan-debounce.processor.ts
 * Purpose: continuous-scan-debounce job 的处理器。
 *          延迟 job 到期后，从 Redis 取出最终 webhookEventId，
 *          按 topic 分发到 product / collection 增量扫描 job。
 */
import { consume } from "../../server/modules/scan/continuous/debounce.service";
import {
  enqueueProductScan,
  enqueueCollectionScan,
} from "../../server/queues/continuous-scan.queue";
import { createLogger } from "../../server/utils/logger";
import type { ContinuousScanDebouncePayload } from "../../server/queues/continuous-scan.types";

const logger = createLogger({ module: "continuous-scan-debounce-processor" });

/**
 * 处理 debounce 合并窗口到期后的分发逻辑。
 *
 * 1. consume() 读取并删除 debounce key（拿到最终 webhookEventId）
 * 2. 若 key 已不存在（异常情况）：直接结束
 * 3. 按 topic 投递 continuous_scan_product 或 continuous_scan_collection
 */
export async function processContinuousScanDebounceJob(
  data: ContinuousScanDebouncePayload,
): Promise<void> {
  const { shopId, topic, resourceId } = data;

  logger.info({ shopId, topic, resourceId }, "debounce.processor.start");

  try {
    const latestWebhookEventId = await consume(shopId, topic, resourceId);

    if (!latestWebhookEventId) {
      logger.warn(
        { shopId, topic, resourceId },
        "debounce.processor.key_not_found",
      );
      return;
    }

    switch (topic) {
      case "products/update":
        await enqueueProductScan({
          shopId,
          productId: resourceId,
          latestWebhookEventId,
        });
        break;

      case "collections/update":
        await enqueueCollectionScan({
          shopId,
          collectionId: resourceId,
          latestWebhookEventId,
        });
        break;

      default:
        logger.error(
          { shopId, topic, resourceId },
          "debounce.processor.unknown_topic",
        );
        return;
    }

    logger.info(
      { shopId, topic, resourceId, latestWebhookEventId },
      "debounce.processor.completed",
    );
  } catch (error) {
    logger.error(
      { shopId, topic, resourceId, err: error },
      "debounce.processor.failed",
    );
    throw error;
  }
}
