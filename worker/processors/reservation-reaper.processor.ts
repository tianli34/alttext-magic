/**
 * File: worker/processors/reservation-reaper.processor.ts
 * Purpose: reservation-reaper 队列的 Job 处理器。
 *          查询所有 status=ACTIVE 且 expiresAt < now 的 reservation，
 *          调用 releaseReservation 释放占用的额度。
 *
 * ### 幂等性
 * - releaseReservation 内部已处理幂等：已释放的 reservation 返回 changed=false。
 * - 因此重复执行不会重复释放。
 *
 * ### 批量控制
 * - 默认 BATCH_SIZE=100，单次执行最多处理 100 条，避免长时间占用事务。
 */

import prisma from "../../server/db/prisma.server";
import { releaseReservation } from "../../server/modules/billing/credit/credit-reservation.service";
import { createLogger } from "../../server/utils/logger";
import type { ReservationReaperJobData } from "../../server/queues/reservation-reaper.queue";

const logger = createLogger({ module: "reservation-reaper-processor" });

/** 单次执行最多处理的 reservation 数量 */
const DEFAULT_BATCH_SIZE = 100;

/** 释放原因：reservation 因超时过期而被清理 */
const RELEASE_REASON = "reservation_expired";

/**
 * 处理单个 reservation-reaper 任务。
 * 查询过期 ACTIVE 的 reservation，逐条调用 releaseReservation 释放额度。
 *
 * @param data 任务数据（包含 source）
 * @param batchSize 单次最大处理数量，默认 100
 */
export async function processReservationReaperJob(
  data: ReservationReaperJobData,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<void> {
  const { source } = data;

  logger.info({ source, batchSize }, "reservation-reaper.processor.start");

  const now = new Date();

  // 查询所有 status=ACTIVE 且 expiresAt < now 的 reservation
  const expiredReservations = await prisma.creditReservation.findMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lt: now },
    },
    select: {
      id: true,
      shopId: true,
    },
    take: batchSize,
    orderBy: { expiresAt: "asc" },
  });

  if (expiredReservations.length === 0) {
    logger.info({ source }, "reservation-reaper.processor.no-expired");
    return;
  }

  logger.info(
    { source, count: expiredReservations.length },
    "reservation-reaper.processor.found-expired",
  );

  let releasedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const reservation of expiredReservations) {
    try {
      const result = await releaseReservation({
        shopId: reservation.shopId,
        reservationId: reservation.id,
        reason: RELEASE_REASON,
      });

      if (result.changed) {
        releasedCount++;
      } else {
        skippedCount++;
      }
    } catch (error: unknown) {
      failedCount++;
      logger.error(
        {
          source,
          reservationId: reservation.id,
          shopId: reservation.shopId,
          err: error,
        },
        "reservation-reaper.processor.release-failed",
      );
    }
  }

  logger.info(
    {
      source,
      total: expiredReservations.length,
      releasedCount,
      skippedCount,
      failedCount,
    },
    "reservation-reaper.processor.completed",
  );

  // 如果全部失败，抛出错误以触发 BullMQ 重试
  if (failedCount > 0 && releasedCount === 0 && expiredReservations.length > 0) {
    throw new Error(
      `[reservation-reaper] 所有 reservation 释放失败 (failures: ${failedCount})`,
    );
  }
}
