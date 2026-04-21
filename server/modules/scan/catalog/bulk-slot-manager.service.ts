/**
 * File: server/modules/scan/catalog/bulk-slot-manager.service.ts
 * Purpose: 统一管理单店 Bulk Query 并发槽位。
 */
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import { listRunningBulkQueryOperations } from "./shopify-bulk.client.server";

const logger = createLogger({ module: "bulk-slot-manager" });
export const MAX_SHOPIFY_BULK_QUERY_CONCURRENCY = 5;

export class BulkSlotManager {
  async getRunningBulkCount(shopId: string): Promise<number> {
    try {
      const localCount = await prisma.scanTaskAttempt.count({
        where: {
          shopId,
          status: {
            in: ["PENDING", "RUNNING"],
          },
          scanTask: {
            status: "RUNNING",
          },
        },
      });

      if (
        localCount >= 0 &&
        localCount <= MAX_SHOPIFY_BULK_QUERY_CONCURRENCY
      ) {
        return localCount;
      }

      logger.warn(
        { shopId, localCount },
        "bulk-slot-manager.local-count-out-of-range",
      );
    } catch (error) {
      logger.warn(
        { shopId, err: error },
        "bulk-slot-manager.local-count-failed",
      );
    }

    const remoteCount = (await listRunningBulkQueryOperations(shopId)).length;
    logger.info(
      { shopId, remoteCount },
      "bulk-slot-manager.remote-count-fallback",
    );
    return remoteCount;
  }

  async availableSlots(shopId: string): Promise<number> {
    const runningCount = await this.getRunningBulkCount(shopId);
    return Math.max(0, MAX_SHOPIFY_BULK_QUERY_CONCURRENCY - runningCount);
  }

  async canSubmit(shopId: string): Promise<boolean> {
    return (await this.availableSlots(shopId)) > 0;
  }
}

export const bulkSlotManager = new BulkSlotManager();
