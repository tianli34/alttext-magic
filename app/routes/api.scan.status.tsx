/**
 * File: app/routes/api.scan.status.tsx
 * Purpose: GET /api/scan/status —— 扫描状态查询接口。
 *          支持按 scanJobId 查询，返回：
 *          - scan_job 总状态（含 publish 状态、时间戳）
 *          - task 列表（含每个 task 的最新 attempt 状态）
 *          - 可选 Redis 进度摘要
 *          - lastPublishedAt
 *
 * 查询参数: scanJobId (必填)
 * 响应体: ScanStatusResponse
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getScanStatus } from "../../server/modules/scan/catalog/scan-job.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.scan.status" });

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
    logger.warn({ shopDomain }, "Shop not found for scan status");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 3. 解析查询参数
  const url = new URL(request.url);
  const scanJobId = url.searchParams.get("scanJobId");

  if (!scanJobId) {
    return Response.json(
      { error: "Missing required query parameter: scanJobId" },
      { status: 400 },
    );
  }

  // 4. 调用服务获取状态
  const data = await getScanStatus(scanJobId, shop.id);

  if (!data) {
    return Response.json(
      { error: "Scan job not found" },
      { status: 404 },
    );
  }

  return Response.json(data);
};
