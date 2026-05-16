/**
 * File: server/modules/generation/generation-credit.service.ts
 * Purpose: 生成管线按 candidate 粒度结算预留额度。
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "generation-credit-service" });

type TransactionClient = Prisma.TransactionClient;
type CreditAction = "CONSUME" | "RELEASE";

interface ResolveOneCreditParams {
  shopId: string;
  batchId: string;
  candidateId: string;
}

export interface ResolveOneCreditResult {
  changed: boolean;
  reservationId: string;
}

export interface ReleaseUnusedReservationResult {
  changed: boolean;
  reservationId: string | null;
  releasedAmount: number;
}

interface LockedReservationRow {
  id: string;
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`[generation-credit] ${fieldName} 不能为空`);
  }
}

function buildLedgerIdempotencyKey(
  batchId: string,
  candidateId: string,
  action: CreditAction,
): string {
  return `gen:${batchId}:${candidateId}:${action.toLowerCase()}`;
}

function buildUnusedReleaseLedgerIdempotencyKey(
  batchId: string,
  lineId: string,
): string {
  return `gen:${batchId}:unused:${lineId}:release`;
}

async function lockReservation(
  tx: TransactionClient,
  shopId: string,
  batchId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<LockedReservationRow[]>`
    SELECT id
    FROM credit_reservation
    WHERE shop_id = ${shopId}
      AND batch_id = ${batchId}
    FOR UPDATE
  `;

  return rows[0]?.id ?? null;
}

function resolveReservationStatus(input: {
  reservedAmount: number;
  consumedAmount: number;
  releasedAmount: number;
}): "ACTIVE" | "PARTIALLY_CONSUMED" | "CONSUMED" | "RELEASED" {
  const resolvedAmount = input.consumedAmount + input.releasedAmount;

  if (resolvedAmount <= 0) {
    return "ACTIVE";
  }
  if (input.consumedAmount === input.reservedAmount) {
    return "CONSUMED";
  }
  if (input.releasedAmount === input.reservedAmount) {
    return "RELEASED";
  }
  return "PARTIALLY_CONSUMED";
}

async function resolveOneCredit(
  params: ResolveOneCreditParams,
  action: CreditAction,
  client: PrismaClient = prisma,
): Promise<ResolveOneCreditResult> {
  const { shopId, batchId, candidateId } = params;
  assertNonEmpty(shopId, "shopId");
  assertNonEmpty(batchId, "batchId");
  assertNonEmpty(candidateId, "candidateId");

  const idempotencyKey = buildLedgerIdempotencyKey(batchId, candidateId, action);

  return client.$transaction(async (tx) => {
    const existingLedger = await tx.creditLedger.findUnique({
      where: { idempotencyKey },
      select: { reservationId: true },
    });

    if (existingLedger?.reservationId) {
      return { changed: false, reservationId: existingLedger.reservationId };
    }

    const reservationId = await lockReservation(tx, shopId, batchId);
    if (!reservationId) {
      throw new Error(`[generation-credit] reservation 不存在: batchId=${batchId}`);
    }

    const reservation = await tx.creditReservation.findFirst({
      where: { id: reservationId, shopId },
      include: { lines: { orderBy: { createdAt: "asc" } } },
    });

    if (!reservation) {
      throw new Error(`[generation-credit] reservation 不存在: ${reservationId}`);
    }
    if (reservation.status !== "ACTIVE" && reservation.status !== "PARTIALLY_CONSUMED") {
      throw new Error(`[generation-credit] reservation 不可结算，当前: ${reservation.status}`);
    }

    const line = reservation.lines.find((item) => {
      const remaining = item.reservedAmount - item.consumedAmount - item.releasedAmount;
      return remaining > 0;
    });

    if (!line) {
      throw new Error(`[generation-credit] reservation 无可结算额度: ${reservationId}`);
    }

    const now = new Date();
    const bucket = await tx.creditBucket.update({
      where: { id: line.bucketId },
      data:
        action === "CONSUME"
          ? {
              reservedAmount: { decrement: 1 },
              consumedAmount: { increment: 1 },
            }
          : {
              reservedAmount: { decrement: 1 },
              remainingAmount: { increment: 1 },
            },
      select: { remainingAmount: true },
    });

    await tx.creditReservationLine.update({
      where: { id: line.id },
      data:
        action === "CONSUME"
          ? { consumedAmount: { increment: 1 } }
          : { releasedAmount: { increment: 1 } },
    });

    await tx.creditLedger.create({
      data: {
        shopId,
        bucketId: line.bucketId,
        reservationId: reservation.id,
        reservationLineId: line.id,
        type: action,
        deltaAmount: action === "CONSUME" ? -1 : 1,
        balanceAfter: bucket.remainingAmount,
        reason: action === "CONSUME" ? "生成候选正式消费" : "生成候选释放预留",
        metadata: {
          batchId,
          candidateId,
        } as Prisma.InputJsonObject,
        idempotencyKey,
        eventAt: now,
      },
    });

    const consumedAmount =
      reservation.consumedAmount + (action === "CONSUME" ? 1 : 0);
    const releasedAmount =
      reservation.releasedAmount + (action === "RELEASE" ? 1 : 0);
    const nextStatus = resolveReservationStatus({
      reservedAmount: reservation.reservedAmount,
      consumedAmount,
      releasedAmount,
    });
    const resolvedAt =
      consumedAmount + releasedAmount >= reservation.reservedAmount ? now : null;

    await tx.creditReservation.update({
      where: { id: reservation.id },
      data: {
        status: nextStatus,
        consumedAmount,
        releasedAmount,
        resolvedAt,
      },
    });

    logger.info(
      { shopId, batchId, candidateId, reservationId: reservation.id, action },
      "generation-credit.resolved",
    );

    return { changed: true, reservationId: reservation.id };
  });
}

async function releaseUnusedReservation(
  params: Pick<ResolveOneCreditParams, "shopId" | "batchId">,
  client: PrismaClient = prisma,
): Promise<ReleaseUnusedReservationResult> {
  const { shopId, batchId } = params;
  assertNonEmpty(shopId, "shopId");
  assertNonEmpty(batchId, "batchId");

  return client.$transaction(async (tx) => {
    const reservationId = await lockReservation(tx, shopId, batchId);
    if (!reservationId) {
      logger.warn({ shopId, batchId }, "generation-credit.unused-release.no-reservation");
      return { changed: false, reservationId: null, releasedAmount: 0 };
    }

    const reservation = await tx.creditReservation.findFirst({
      where: { id: reservationId, shopId },
      include: { lines: { orderBy: { createdAt: "asc" } } },
    });

    if (!reservation) {
      throw new Error(`[generation-credit] reservation 不存在: ${reservationId}`);
    }

    if (
      reservation.status === "CONSUMED" ||
      reservation.status === "RELEASED" ||
      reservation.status === "EXPIRED" ||
      reservation.status === "CANCELED" ||
      reservation.status === "FAILED"
    ) {
      return { changed: false, reservationId: reservation.id, releasedAmount: 0 };
    }
    if (reservation.status !== "ACTIVE" && reservation.status !== "PARTIALLY_CONSUMED") {
      throw new Error(`[generation-credit] reservation 不可释放剩余额度，当前: ${reservation.status}`);
    }

    const now = new Date();
    let releasedTotal = 0;

    for (const line of reservation.lines) {
      const remainingReserved = line.reservedAmount - line.consumedAmount - line.releasedAmount;
      if (remainingReserved <= 0) continue;

      const idempotencyKey = buildUnusedReleaseLedgerIdempotencyKey(batchId, line.id);
      const existingLedger = await tx.creditLedger.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });
      if (existingLedger) continue;

      await tx.creditReservationLine.update({
        where: { id: line.id },
        data: { releasedAmount: { increment: remainingReserved } },
      });

      const bucket = await tx.creditBucket.update({
        where: { id: line.bucketId },
        data: {
          reservedAmount: { decrement: remainingReserved },
          remainingAmount: { increment: remainingReserved },
        },
        select: { remainingAmount: true },
      });

      await tx.creditLedger.create({
        data: {
          shopId,
          bucketId: line.bucketId,
          reservationId: reservation.id,
          reservationLineId: line.id,
          type: "RELEASE",
          deltaAmount: remainingReserved,
          balanceAfter: bucket.remainingAmount,
          reason: "生成 batch 完成后释放未使用预留",
          metadata: {
            batchId,
            releaseType: "GENERATION_BATCH_UNUSED",
          } as Prisma.InputJsonObject,
          idempotencyKey,
          eventAt: now,
        },
      });

      releasedTotal += remainingReserved;
    }

    if (releasedTotal <= 0) {
      return { changed: false, reservationId: reservation.id, releasedAmount: 0 };
    }

    const consumedAmount = reservation.consumedAmount;
    const releasedAmount = reservation.releasedAmount + releasedTotal;
    const nextStatus = resolveReservationStatus({
      reservedAmount: reservation.reservedAmount,
      consumedAmount,
      releasedAmount,
    });
    const resolvedAt =
      consumedAmount + releasedAmount >= reservation.reservedAmount ? now : null;

    await tx.creditReservation.update({
      where: { id: reservation.id },
      data: {
        status: nextStatus,
        releasedAmount,
        resolvedAt,
      },
    });

    logger.info(
      { shopId, batchId, reservationId: reservation.id, releasedTotal },
      "generation-credit.unused-released",
    );

    return {
      changed: true,
      reservationId: reservation.id,
      releasedAmount: releasedTotal,
    };
  });
}

export const GenerationCreditService = {
  consume(params: ResolveOneCreditParams, client?: PrismaClient) {
    return resolveOneCredit(params, "CONSUME", client);
  },

  releaseReservation(params: ResolveOneCreditParams, client?: PrismaClient) {
    return resolveOneCredit(params, "RELEASE", client);
  },

  releaseUnusedReservation(
    params: Pick<ResolveOneCreditParams, "shopId" | "batchId">,
    client?: PrismaClient,
  ) {
    return releaseUnusedReservation(params, client);
  },
};
