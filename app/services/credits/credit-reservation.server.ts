/**
 * File: app/services/credits/credit-reservation.server.ts
 * Purpose: batch 级额度预留服务，在事务内完成预留、消费确认与释放返还。
 */

import { Prisma, type CreditReservation, type CreditReservationLine, type PrismaClient } from '@prisma/client';

import prisma from '../../../server/db/prisma.server.js';
import { createLogger } from '../../../server/utils/logger.js';
import { sortBucketsByConsumptionOrder, type SpendableBucket } from '../../../server/modules/billing/credit/consumption-order.js';
import type { CreditBucketType } from '../../../server/modules/billing/billing.types.js';

const log = createLogger({ module: 'credit-reservation' });

type TransactionClient = Prisma.TransactionClient;
const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

interface ReservationBucket {
  id: string;
  bucketType: CreditBucketType;
  remainingAmount: number;
  effectiveAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
}

interface LockedBucketRow {
  id: string;
}

export interface CreateReservationParams {
  shopId: string;
  batchId: string;
  amount: number;
  expiresAt?: Date | null;
}

export interface ConsumeReservationParams {
  shopId: string;
  reservationId: string;
}

export interface ReleaseReservationParams {
  shopId: string;
  reservationId: string;
  reason: string;
}

export interface CreditReservationWithLines extends CreditReservation {
  lines: CreditReservationLine[];
}

export interface CreateReservationResult {
  reservation: CreditReservationWithLines;
  created: boolean;
}

export interface ResolveReservationResult {
  reservation: CreditReservationWithLines;
  changed: boolean;
}

export class InsufficientCreditError extends Error {
  readonly requested: number;
  readonly available: number;

  constructor(requested: number, available: number) {
    super(`[credit-reservation] 额度不足，requested=${requested}, available=${available}`);
    this.name = 'InsufficientCreditError';
    this.requested = requested;
    this.available = available;
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`[credit-reservation] ${fieldName} 不能为空`);
  }
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[credit-reservation] ${fieldName} 必须为正整数，当前: ${value}`);
  }
}

function buildReservationIdempotencyKey(shopId: string, batchId: string): string {
  return `${shopId}:batch:${batchId}:reservation`;
}

function buildLedgerIdempotencyKey(
  reservationId: string,
  lineId: string,
  type: 'RESERVE' | 'CONSUME' | 'RELEASE',
): string {
  return `${reservationId}:${lineId}:${type}`;
}

function toReservationWithLines(reservation: CreditReservation & { lines: CreditReservationLine[] }): CreditReservationWithLines {
  return reservation;
}

async function loadReservationWithLines(
  tx: TransactionClient,
  shopId: string,
  reservationId: string,
): Promise<CreditReservationWithLines | null> {
  const reservation = await tx.creditReservation.findFirst({
    where: { id: reservationId, shopId },
    include: { lines: true },
  });

  return reservation ? toReservationWithLines(reservation) : null;
}

async function lockReservation(tx: TransactionClient, shopId: string, reservationId: string): Promise<void> {
  await tx.$queryRaw<LockedBucketRow[]>`
    SELECT id
    FROM credit_reservation
    WHERE id = ${reservationId}
      AND shop_id = ${shopId}
    FOR UPDATE
  `;
}

async function lockSpendableBuckets(tx: TransactionClient, shopId: string, now: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<LockedBucketRow[]>`
    SELECT id
    FROM credit_bucket
    WHERE shop_id = ${shopId}
      AND status = 'ACTIVE'
      AND remaining_amount > 0
      AND effective_at <= ${now}
      AND (expires_at IS NULL OR expires_at > ${now})
    FOR UPDATE
  `;

  return rows.map((row) => row.id);
}

async function getLockedSpendableBuckets(
  tx: TransactionClient,
  shopId: string,
  now: Date,
): Promise<ReservationBucket[]> {
  const lockedIds = await lockSpendableBuckets(tx, shopId, now);
  if (lockedIds.length === 0) return [];

  const buckets = await tx.creditBucket.findMany({
    where: {
      id: { in: lockedIds },
      shopId,
      status: 'ACTIVE',
      remainingAmount: { gt: 0 },
      effectiveAt: { lte: now },
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    select: {
      id: true,
      bucketType: true,
      remainingAmount: true,
      effectiveAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return sortBucketsByConsumptionOrder(
    buckets.map((bucket) => ({
      id: bucket.id,
      bucketType: bucket.bucketType as CreditBucketType,
      remainingAmount: bucket.remainingAmount,
      effectiveAt: bucket.effectiveAt,
      expiresAt: bucket.expiresAt,
      createdAt: bucket.createdAt,
    })),
    (bucket): SpendableBucket => ({
      bucketType: bucket.bucketType,
      remainingAmount: bucket.remainingAmount,
      effectiveAt: bucket.effectiveAt,
      expiresAt: bucket.expiresAt,
      createdAt: bucket.createdAt,
    }),
  );
}

function planReservationLines(
  buckets: readonly ReservationBucket[],
  amount: number,
): Array<{ bucketId: string; amount: number }> {
  let remaining = amount;
  const lines: Array<{ bucketId: string; amount: number }> = [];

  for (const bucket of buckets) {
    if (remaining <= 0) break;

    const take = Math.min(bucket.remainingAmount, remaining);
    if (take > 0) {
      lines.push({ bucketId: bucket.id, amount: take });
      remaining -= take;
    }
  }

  if (remaining > 0) {
    throw new InsufficientCreditError(amount, amount - remaining);
  }

  return lines;
}

function resolveReleaseStatus(reason: string): 'RELEASED' | 'EXPIRED' {
  return reason.trim().toUpperCase() === 'EXPIRED' ? 'EXPIRED' : 'RELEASED';
}

export async function createReservation(
  params: CreateReservationParams,
  client: PrismaClient = prisma,
): Promise<CreateReservationResult> {
  const { shopId, batchId, amount, expiresAt } = params;

  assertNonEmpty(shopId, 'shopId');
  assertNonEmpty(batchId, 'batchId');
  assertPositiveInteger(amount, 'amount');

  const idempotencyKey = buildReservationIdempotencyKey(shopId, batchId);

  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.creditReservation.findUnique({
        where: { shopId_batchId: { shopId, batchId } },
        include: { lines: true },
      });

      if (existing) {
        log.info({ shopId, batchId, reservationId: existing.id }, 'reservation 已存在，按幂等返回');
        return { reservation: toReservationWithLines(existing), created: false };
      }

      const now = new Date();
      const buckets = await getLockedSpendableBuckets(tx, shopId, now);
      const plannedLines = planReservationLines(buckets, amount);

      const reservation = await tx.creditReservation.create({
        data: {
          shopId,
          batchId,
          idempotencyKey,
          status: 'ACTIVE',
          requestedAmount: amount,
          reservedAmount: amount,
          consumedAmount: 0,
          releasedAmount: 0,
          expiresAt: expiresAt ?? null,
        },
      });

      const createdLines: CreditReservationLine[] = [];

      for (const line of plannedLines) {
        const updated = await tx.creditBucket.updateMany({
          where: {
            id: line.bucketId,
            shopId,
            remainingAmount: { gte: line.amount },
          },
          data: {
            remainingAmount: { decrement: line.amount },
            reservedAmount: { increment: line.amount },
          },
        });

        if (updated.count !== 1) {
          throw new InsufficientCreditError(amount, amount - line.amount);
        }

        const currentBucket = await tx.creditBucket.findUniqueOrThrow({
          where: { id: line.bucketId },
          select: { remainingAmount: true },
        });

        const reservationLine = await tx.creditReservationLine.create({
          data: {
            shopId,
            reservationId: reservation.id,
            bucketId: line.bucketId,
            reservedAmount: line.amount,
            consumedAmount: 0,
            releasedAmount: 0,
          },
        });
        createdLines.push(reservationLine);

        await tx.creditLedger.create({
          data: {
            shopId,
            bucketId: line.bucketId,
            reservationId: reservation.id,
            reservationLineId: reservationLine.id,
            type: 'RESERVE',
            deltaAmount: -line.amount,
            balanceAfter: currentBucket.remainingAmount,
            reason: 'batch 额度预留',
            metadata: {
              batchId,
              requestedAmount: amount,
            } as Prisma.InputJsonObject,
            idempotencyKey: buildLedgerIdempotencyKey(reservation.id, reservationLine.id, 'RESERVE'),
            eventAt: now,
          },
        });
      }

      log.info({ shopId, batchId, reservationId: reservation.id, amount }, 'reservation 创建完成');

      return {
        reservation: {
          ...reservation,
          lines: createdLines,
        },
        created: true,
      };
    });
  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const existing = await client.creditReservation.findUnique({
        where: { shopId_batchId: { shopId, batchId } },
        include: { lines: true },
      });

      if (existing) {
        log.info({ shopId, batchId, reservationId: existing.id }, 'reservation 并发创建冲突，按幂等返回');
        return { reservation: toReservationWithLines(existing), created: false };
      }
    }

    throw error;
  }
}

export async function consumeReservation(
  params: ConsumeReservationParams,
  client: PrismaClient = prisma,
): Promise<ResolveReservationResult> {
  const { shopId, reservationId } = params;

  assertNonEmpty(shopId, 'shopId');
  assertNonEmpty(reservationId, 'reservationId');

  return client.$transaction(async (tx) => {
    await lockReservation(tx, shopId, reservationId);

    const reservation = await loadReservationWithLines(tx, shopId, reservationId);
    if (!reservation) {
      throw new Error(`[credit-reservation] reservation 不存在: ${reservationId}`);
    }

    if (reservation.status === 'CONSUMED') {
      return { reservation, changed: false };
    }
    if (reservation.status !== 'ACTIVE') {
      throw new Error(`[credit-reservation] 仅 ACTIVE reservation 可消费，当前: ${reservation.status}`);
    }

    const now = new Date();

    for (const line of reservation.lines) {
      const remainingReserved = line.reservedAmount - line.consumedAmount - line.releasedAmount;
      if (remainingReserved <= 0) continue;

      await tx.creditReservationLine.update({
        where: { id: line.id },
        data: {
          consumedAmount: { increment: remainingReserved },
        },
      });

      const bucket = await tx.creditBucket.update({
        where: { id: line.bucketId },
        data: {
          reservedAmount: { decrement: remainingReserved },
          consumedAmount: { increment: remainingReserved },
        },
        select: {
          remainingAmount: true,
        },
      });

      await tx.creditLedger.create({
        data: {
          shopId,
          bucketId: line.bucketId,
          reservationId: reservation.id,
          reservationLineId: line.id,
          type: 'CONSUME',
          deltaAmount: -remainingReserved,
          balanceAfter: bucket.remainingAmount,
          reason: 'reservation 转正式消费',
          metadata: {
            batchId: reservation.batchId,
          } as Prisma.InputJsonObject,
          idempotencyKey: buildLedgerIdempotencyKey(reservation.id, line.id, 'CONSUME'),
          eventAt: now,
        },
      });
    }

    const updatedReservation = await tx.creditReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'CONSUMED',
        consumedAmount: reservation.reservedAmount,
        resolvedAt: now,
      },
      include: { lines: true },
    });

    log.info({ shopId, reservationId }, 'reservation 消费完成');

    return { reservation: toReservationWithLines(updatedReservation), changed: true };
  });
}

export async function releaseReservation(
  params: ReleaseReservationParams,
  client: PrismaClient = prisma,
): Promise<ResolveReservationResult> {
  const { shopId, reservationId, reason } = params;

  assertNonEmpty(shopId, 'shopId');
  assertNonEmpty(reservationId, 'reservationId');
  assertNonEmpty(reason, 'reason');

  return client.$transaction(async (tx) => {
    await lockReservation(tx, shopId, reservationId);

    const reservation = await loadReservationWithLines(tx, shopId, reservationId);
    if (!reservation) {
      throw new Error(`[credit-reservation] reservation 不存在: ${reservationId}`);
    }

    if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED') {
      return { reservation, changed: false };
    }
    if (reservation.status !== 'ACTIVE') {
      throw new Error(`[credit-reservation] 仅 ACTIVE reservation 可释放，当前: ${reservation.status}`);
    }

    const now = new Date();
    const targetStatus = resolveReleaseStatus(reason);
    let releasedTotal = 0;

    for (const line of reservation.lines) {
      const remainingReserved = line.reservedAmount - line.consumedAmount - line.releasedAmount;
      if (remainingReserved <= 0) continue;

      await tx.creditReservationLine.update({
        where: { id: line.id },
        data: {
          releasedAmount: { increment: remainingReserved },
        },
      });

      const bucket = await tx.creditBucket.update({
        where: { id: line.bucketId },
        data: {
          remainingAmount: { increment: remainingReserved },
          reservedAmount: { decrement: remainingReserved },
        },
        select: {
          remainingAmount: true,
        },
      });

      await tx.creditLedger.create({
        data: {
          shopId,
          bucketId: line.bucketId,
          reservationId: reservation.id,
          reservationLineId: line.id,
          type: 'RELEASE',
          deltaAmount: remainingReserved,
          balanceAfter: bucket.remainingAmount,
          reason,
          metadata: {
            batchId: reservation.batchId,
            status: targetStatus,
          } as Prisma.InputJsonObject,
          idempotencyKey: buildLedgerIdempotencyKey(reservation.id, line.id, 'RELEASE'),
          eventAt: now,
        },
      });

      releasedTotal += remainingReserved;
    }

    const updatedReservation = await tx.creditReservation.update({
      where: { id: reservation.id },
      data: {
        status: targetStatus,
        releasedAmount: reservation.releasedAmount + releasedTotal,
        resolvedAt: now,
      },
      include: { lines: true },
    });

    log.info({ shopId, reservationId, releasedTotal, status: targetStatus }, 'reservation 释放完成');

    return { reservation: toReservationWithLines(updatedReservation), changed: true };
  });
}
