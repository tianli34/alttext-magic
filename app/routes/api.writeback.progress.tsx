/**
 * File: app/routes/api.writeback.progress.tsx
 * Purpose: GET /api/writeback/progress?batchId=xxx —— 写回进度 SSE 端点。
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { startWritebackSSEStream } from "../../server/sse/writeback-sse.service";
import { getWritebackProgressSnapshot } from "../../server/modules/writeback/writeback-batch.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.writeback.progress" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
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

  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  if (!batchId) {
    return Response.json(
      { error: "Missing required query parameter: batchId" },
      { status: 400 },
    );
  }

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

      const cleanup = startWritebackSSEStream(shop.id, batchId, writer);
      request.signal.addEventListener("abort", cleanup);
    },
  });

  logger.info({ shopId: shop.id, batchId }, "writeback.sse.started");

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
