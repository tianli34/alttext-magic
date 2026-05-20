/**
 * File: app/routes/api.writeback.batch.$batchId.tsx
 * Purpose: GET /api/writeback/batch/:batchId —— 查询写回批次详情与分类统计。
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getWritebackBatchDetail } from "../../server/modules/writeback/writeback-batch.service";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const batchId = params.batchId;
  if (!batchId) {
    return Response.json({ error: "Missing batchId" }, { status: 400 });
  }

  const detail = await getWritebackBatchDetail(shop.id, batchId);
  if (!detail) {
    return Response.json({ error: "Writeback batch not found" }, { status: 404 });
  }

  return Response.json(detail);
};
