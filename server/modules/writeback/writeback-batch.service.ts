/**
 * File: server/modules/writeback/writeback-batch.service.ts
 * Purpose: 写回批次查询服务，供 SSE 进度、完成汇总与刷新恢复使用。
 */
import {
  AltPlane,
  JobBatchStatus,
  JobBatchType,
  type PrismaClient,
} from "@prisma/client";
import prisma from "../../db/prisma.server";

const TERMINAL_STATUSES = new Set<JobBatchStatus>([
  JobBatchStatus.SUCCESS,
  JobBatchStatus.PARTIAL_SUCCESS,
  JobBatchStatus.FAILED,
]);

export interface WritebackProgressSnapshot {
  batchId: string;
  status: JobBatchStatus;
  total: number;
  success: number;
  fail: number;
  skip: number;
  pending: number;
}

export interface WritebackTypeStat {
  altPlane: AltPlane;
  total: number;
  success: number;
  fail: number;
  skip: number;
}

export interface WritebackBatchDetail extends WritebackProgressSnapshot {
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  typeStats: WritebackTypeStat[];
  isTerminal: boolean;
}

export function isWritebackBatchTerminal(status: JobBatchStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export async function getWritebackProgressSnapshot(
  shopId: string,
  batchId: string,
  client: Pick<PrismaClient, "jobBatch"> = prisma,
): Promise<WritebackProgressSnapshot | null> {
  const batch = await client.jobBatch.findFirst({
    where: {
      id: batchId,
      shopId,
      type: JobBatchType.WRITEBACK,
    },
    select: {
      id: true,
      status: true,
      total: true,
      success: true,
      failed: true,
      skipped: true,
    },
  });

  if (!batch) return null;

  return mapBatchToProgress(batch);
}

export async function getWritebackBatchDetail(
  shopId: string,
  batchId: string,
  client: Pick<PrismaClient, "jobBatch" | "jobItem"> = prisma,
): Promise<WritebackBatchDetail | null> {
  const batch = await client.jobBatch.findFirst({
    where: {
      id: batchId,
      shopId,
      type: JobBatchType.WRITEBACK,
    },
    select: {
      id: true,
      status: true,
      total: true,
      success: true,
      failed: true,
      skipped: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  if (!batch) return null;

  const items = await client.jobItem.findMany({
    where: { batchId },
    select: {
      status: true,
      altCandidate: {
        select: {
          altTarget: {
            select: {
              altPlane: true,
            },
          },
        },
      },
    },
  });

  const progress = mapBatchToProgress(batch);
  const typeStats = buildTypeStats(items);
  const durationMs = batch.finishedAt
    ? batch.finishedAt.getTime() - batch.startedAt.getTime()
    : null;

  return {
    ...progress,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    durationMs,
    typeStats,
    isTerminal: isWritebackBatchTerminal(batch.status),
  };
}

function mapBatchToProgress(batch: {
  id: string;
  status: JobBatchStatus;
  total: number;
  success: number;
  failed: number;
  skipped: number;
}): WritebackProgressSnapshot {
  const completed = batch.success + batch.failed + batch.skipped;

  return {
    batchId: batch.id,
    status: batch.status,
    total: batch.total,
    success: batch.success,
    fail: batch.failed,
    skip: batch.skipped,
    pending: Math.max(batch.total - completed, 0),
  };
}

function buildTypeStats(
  items: Array<{
    status: string;
    altCandidate: { altTarget: { altPlane: AltPlane } };
  }>,
): WritebackTypeStat[] {
  const stats = new Map<AltPlane, WritebackTypeStat>();

  for (const item of items) {
    const altPlane = item.altCandidate.altTarget.altPlane;
    const current = stats.get(altPlane) ?? {
      altPlane,
      total: 0,
      success: 0,
      fail: 0,
      skip: 0,
    };

    current.total += 1;
    if (item.status === "SUCCESS") current.success += 1;
    if (item.status === "FAILED") current.fail += 1;
    if (item.status === "SKIPPED_ALREADY_FILLED") current.skip += 1;
    stats.set(altPlane, current);
  }

  return Array.from(stats.values()).sort((a, b) =>
    a.altPlane.localeCompare(b.altPlane),
  );
}
