/**
 * File: server/modules/writeback/history.service.ts
 * Purpose: 写回审计历史查询服务。
 */
import { AltPlane, type Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db/prisma.server";

export interface HistoryQuery {
  page: number;
  pageSize: number;
  altPlane?: AltPlane;
  from: Date;
  to: Date;
}

export interface HistoryItem {
  id: string;
  altPlane: AltPlane;
  oldAltText: string | null;
  newAltText: string;
  modelUsed: string;
  writtenAt: Date;
  altTarget: {
    shopifyGid: string;
    thumbnailUrl: string | null;
    primaryUsage: {
      type: string;
      id: string;
      title: string | null;
      handle: string | null;
      positionIndex: number | null;
    } | null;
  };
}

export interface HistoryResponse {
  items: HistoryItem[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 100;

export function defaultHistoryFrom(now = new Date()): Date {
  const from = new Date(now);
  from.setDate(from.getDate() - 90);
  return from;
}

export async function listWritebackHistory(
  shopId: string,
  query: HistoryQuery,
  client: Pick<PrismaClient, "auditLog"> = prisma,
): Promise<HistoryResponse> {
  const where: Prisma.AuditLogWhereInput = {
    shopId,
    writtenAt: {
      gte: query.from,
      lte: query.to,
    },
  };

  if (query.altPlane) {
    where.altPlane = query.altPlane;
  }

  const skip = (query.page - 1) * query.pageSize;
  const [rows, total] = await Promise.all([
    client.auditLog.findMany({
      where,
      orderBy: { writtenAt: "desc" },
      skip,
      take: query.pageSize,
      select: {
        id: true,
        altPlane: true,
        oldAltText: true,
        newAltText: true,
        modelUsed: true,
        writtenAt: true,
        altTarget: {
          select: {
            writeTargetId: true,
            previewUrl: true,
            groupProjections: {
              take: 1,
              orderBy: { id: "asc" },
              select: {
                primaryUsageType: true,
                primaryUsageId: true,
                primaryTitle: true,
                primaryHandle: true,
                primaryPositionIndex: true,
              },
            },
          },
        },
      },
    }),
    client.auditLog.count({ where }),
  ]);

  return {
    items: rows.map((row) => {
      const primaryUsage = row.altTarget.groupProjections[0] ?? null;
      return {
        id: row.id,
        altPlane: row.altPlane,
        oldAltText: row.oldAltText,
        newAltText: row.newAltText,
        modelUsed: row.modelUsed,
        writtenAt: row.writtenAt,
        altTarget: {
          shopifyGid: row.altTarget.writeTargetId,
          thumbnailUrl: row.altTarget.previewUrl,
          primaryUsage: primaryUsage
            ? {
                type: primaryUsage.primaryUsageType,
                id: primaryUsage.primaryUsageId,
                title: primaryUsage.primaryTitle,
                handle: primaryUsage.primaryHandle,
                positionIndex: primaryUsage.primaryPositionIndex,
              }
            : null,
        },
      };
    }),
    meta: {
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(Math.ceil(total / query.pageSize), 1),
    },
  };
}
