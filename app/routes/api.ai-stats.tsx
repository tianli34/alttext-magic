/**
 * 文件: app/routes/api.ai-stats.tsx
 * 用途: GET /api/ai-stats — 返回当前店铺 AiModelCall 聚合统计
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.ai-stats" });

interface StatusDuration {
  avgDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
}

interface ModelStat {
  modelName: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  successDuration: StatusDuration;
  failedDuration: StatusDuration;
}

interface AiStatsResponse {
  overall: {
    total: number;
    success: number;
    failed: number;
    successRate: number;
    successDuration: StatusDuration;
    failedDuration: StatusDuration;
  };
  byModel: ModelStat[];
}

function buildStatusDuration(row: {
  _avg: { durationMs: number | null };
  _max: { durationMs: number | null };
  _min: { durationMs: number | null };
}): StatusDuration {
  return {
    avgDurationMs: Math.round(row._avg.durationMs ?? 0),
    maxDurationMs: row._max.durationMs ?? 0,
    minDurationMs: row._min.durationMs ?? 0,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for ai-stats");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  /* ---- 按 status 聚合整体统计 ---- */
  const overallRows = await prisma.aiModelCall.groupBy({
    by: ["status"],
    where: { shopId: shop.id },
    _count: { id: true },
    _avg: { durationMs: true },
    _max: { durationMs: true },
    _min: { durationMs: true },
  });

  const successRow = overallRows.find((r) => r.status === "SUCCESS");
  const failedRow = overallRows.find((r) => r.status === "FAILED");
  const totalCount =
    (successRow?._count.id ?? 0) + (failedRow?._count.id ?? 0);

  const overall = {
    total: totalCount,
    success: successRow?._count.id ?? 0,
    failed: failedRow?._count.id ?? 0,
    successRate:
      totalCount > 0
        ? Number(
            (
              ((successRow?._count.id ?? 0) / totalCount) *
              100
            ).toFixed(2),
          )
        : 0,
    successDuration: buildStatusDuration(
      successRow ?? {
        _avg: { durationMs: null },
        _max: { durationMs: null },
        _min: { durationMs: null },
      },
    ),
    failedDuration: buildStatusDuration(
      failedRow ?? {
        _avg: { durationMs: null },
        _max: { durationMs: null },
        _min: { durationMs: null },
      },
    ),
  };

  /* ---- 按 modelName + status 分组 ---- */
  const byModelRows = await prisma.aiModelCall.groupBy({
    by: ["modelName", "status"],
    where: { shopId: shop.id },
    _count: { id: true },
    _avg: { durationMs: true },
    _max: { durationMs: true },
    _min: { durationMs: true },
  });

  const modelMap = new Map<
    string,
    {
      modelName: string;
      total: number;
      success: number;
      failed: number;
      successRow: (typeof byModelRows)[number] | null;
      failedRow: (typeof byModelRows)[number] | null;
    }
  >();

  for (const row of byModelRows) {
    const existing = modelMap.get(row.modelName) ?? {
      modelName: row.modelName,
      total: 0,
      success: 0,
      failed: 0,
      successRow: null as (typeof byModelRows)[number] | null,
      failedRow: null as (typeof byModelRows)[number] | null,
    };

    existing.total += row._count.id;

    if (row.status === "SUCCESS") {
      existing.success += row._count.id;
      existing.successRow = row;
    } else {
      existing.failed += row._count.id;
      existing.failedRow = row;
    }

    modelMap.set(row.modelName, existing);
  }

  const byModel: ModelStat[] = Array.from(modelMap.values()).map((m) => ({
    modelName: m.modelName,
    total: m.total,
    success: m.success,
    failed: m.failed,
    successRate:
      m.total > 0
        ? Number(((m.success / m.total) * 100).toFixed(2))
        : 0,
    successDuration: buildStatusDuration(
      m.successRow ?? {
        _avg: { durationMs: null },
        _max: { durationMs: null },
        _min: { durationMs: null },
      },
    ),
    failedDuration: buildStatusDuration(
      m.failedRow ?? {
        _avg: { durationMs: null },
        _max: { durationMs: null },
        _min: { durationMs: null },
      },
    ),
  }));

  return Response.json({ overall, byModel } satisfies AiStatsResponse);
};
