/**
 * File: app/routes/api.generation.progress.$batchId.tsx
 * Purpose: GET /api/generation/progress/:batchId —— 生成阶段 SSE 进度推送端点。
 *          通过 Redis Pub/Sub 订阅实时进度并推送给前端。
 *          连接建立时先发送当前快照，再订阅后续增量事件。
 *          到达终态（COMPLETED / FAILED）或客户端断开时自动关闭流。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { startGenerationSSEStream } from "../../server/sse/generation-sse.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.generation.progress" });

function unauthorizedResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function hasBearerToken(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  return authorization?.toLowerCase().startsWith("bearer ") === true && !!token;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // 1. 鉴权
  if (!hasBearerToken(request)) {
    return unauthorizedResponse();
  }

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

  // 4. 校验 batchId 归属当前 shop（防止越权）
  const batch = await prisma.generationBatch.findUnique({
    where: { id: batchId },
    select: { shopId: true },
  });

  if (!batch || batch.shopId !== shop.id) {
    return Response.json(
      { error: "Generation batch not found" },
      { status: 404 },
    );
  }

  // 5. 构建 SSE 流
  const stream = new ReadableStream({
    start(controller) {
      const adaptedWriter = {
        write: async (chunk: Uint8Array) => {
          controller.enqueue(chunk);
        },
        close: async () => {
          controller.close();
        },
      };

      const cleanup = startGenerationSSEStream(batchId, adaptedWriter);

      // 客户端断开时清理
      request.signal.addEventListener("abort", () => {
        cleanup();
      });
    },
  });

  logger.info({ batchId, shopDomain }, "Generation SSE stream started");

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
