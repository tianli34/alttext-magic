/**
 * File: app/routes/api.bootstrap.tsx
 * Purpose: GET /api/bootstrap —— 前端初始化聚合接口。
 *          返回计划/额度占位、notice 状态、scope 状态、最近扫描状态。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBootstrapData } from "../../server/modules/bootstrap/bootstrap.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.bootstrap" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 鉴权
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 2. 通过 shopDomain 查找内部 shopId
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for bootstrap");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 3. 调用聚合服务
  const data = await getBootstrapData(shop.id);

  return Response.json(data);
};
