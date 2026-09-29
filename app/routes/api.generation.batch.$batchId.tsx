/**
 * File: app/routes/api.generation.batch.$batchId.tsx
 * Purpose: GET /api/generation/batch/:batchId —— 生成批次进度快照（轮询兜底通道）。
 *          与 SSE 端点(/api/generation/progress/:batchId)同口径读同一张 generation_batch 计数，
 *          供前端在 SSE 被隧道/代理整体缓冲、事件收不到时兜底刷新进度，
 *          避免进度条长期停在「0 / N 已完成」。轮询为普通请求-响应，不受流式缓冲影响。
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getGenerationProgressSnapshot } from "../../server/modules/generation/generation-progress.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.generation.batch" });

function unauthorizedResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 1. 鉴权（与 SSE 端点一致：嵌入式环境下跳转一律转 401，前端轮询可静默处理）
  let shopDomain: string;
  try {
    const { session } = await authenticate.admin(request);
    shopDomain = session.shop;
  } catch (error) {
    if (
      error instanceof Response &&
      (error.status === 401 || (error.status >= 300 && error.status < 400))
    ) {
      return unauthorizedResponse();
    }

    throw error;
  }

  // 2. 校验 shop 存在
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 3. 解析路径参数
  const batchId = params.batchId;
  if (!batchId) {
    return Response.json(
      { error: "Missing required path parameter: batchId" },
      { status: 400 },
    );
  }

  // 4. 读取快照（店铺归属校验在 service 内完成，不匹配统一 404 防越权探测）
  const snapshot = await getGenerationProgressSnapshot(shop.id, batchId);
  if (!snapshot) {
    logger.warn({ shopId: shop.id, batchId }, "Generation progress poll: batch not found");
    return Response.json({ error: "Generation batch not found" }, { status: 404 });
  }

  return Response.json(snapshot);
};

export const headers = () => ({ "Cache-Control": "no-store" });
