/**
 * File: app/routes/api.writeback.truth-debug.tsx
 * Purpose: GET /api/writeback/truth-debug?batchId=xxx —— 写回真值复核调试 SSE 端点。
 *          仅 WRITEBACK_TRUTH_DEBUG=true 时可用（关闭时返回 404，视作端点不存在），
 *          实时推送写回 Worker 的真值复核结果事件，供前端弹窗人工核对。
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { env } from "../../server/config/env";
import { startWritebackTruthDebugSSEStream } from "../../server/sse/writeback-truth-debug-sse.service";
import { getWritebackProgressSnapshot } from "../../server/modules/writeback/writeback-batch.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.writeback.truth-debug" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 调试开关关闭时视端点不存在，避免暴露调试通道（前端据此停连且不再重试）
  if (!env.WRITEBACK_TRUTH_DEBUG) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  if (!batchId) {
    return Response.json(
      { error: "Missing required query parameter: batchId" },
      { status: 400 },
    );
  }

  // 校验批次归属当前 shop（防止越权订阅其他店铺的复核事件）
  const snapshot = await getWritebackProgressSnapshot(shop.id, batchId);
  if (!snapshot) {
    return Response.json({ error: "Writeback batch not found" }, { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const writer = {
        write: async (chunk: Uint8Array) => {
          controller.enqueue(chunk);
        },
        close: async () => {
          controller.close();
        },
      };

      const cleanup = startWritebackTruthDebugSSEStream(shop.id, batchId, writer);
      request.signal.addEventListener("abort", cleanup);
    },
  });

  logger.info({ shopId: shop.id, batchId }, "writeback truth debug SSE started");

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
