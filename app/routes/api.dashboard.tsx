/**
 * File: app/routes/api.dashboard.tsx
 * Purpose: GET /api/dashboard —— 返回仪表盘分组统计、最近发布时间和扫描状态。
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getDashboardData } from "../../server/modules/dashboard/dashboard.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.dashboard" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for dashboard");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const data = await getDashboardData(shop.id);

  return Response.json(data);
};
