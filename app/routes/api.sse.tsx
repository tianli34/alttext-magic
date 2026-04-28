/**
 * File: app/routes/api.sse.tsx
 * Purpose: GET /api/sse —— SSE 进度推送端点。
 *          查询参数: scanJobId (必填)
 *          从 Redis 轮询进度并以 SSE 事件格式推送给前端。
 *          到达终态（done/failed）后自动关闭流。
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { startSSEProgressStream } from "../../server/sse/sse.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.sse" });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 鉴权
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 2. 校验 shop 存在
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
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

  // 4. 校验 scanJobId 归属当前 shop（防止越权）
  const scanJob = await prisma.scanJob.findUnique({
    where: { id: scanJobId },
    select: { shopId: true },
  });

  if (!scanJob || scanJob.shopId !== shop.id) {
    return Response.json(
      { error: "Scan job not found" },
      { status: 404 },
    );
  }

  // 5. 构建 SSE 流
  const stream = new ReadableStream({
    start(controller) {
      // 使用 adapter 将 ReadableStreamDefaultController 适配为 WritableStreamDefaultWriter 接口
      const adaptedWriter = {
        write: async (chunk: Uint8Array) => {
          controller.enqueue(chunk);
        },
        close: async () => {
          controller.close();
        },
        abort: async () => {
          controller.close();
        },
        closed: Promise.resolve(undefined),
        desiredSize: null,
        ready: Promise.resolve(undefined),
        releaseLock: () => {},
      };

      const cleanup = startSSEProgressStream(scanJobId, adaptedWriter);

      // 客户端断开时清理
      request.signal.addEventListener("abort", () => {
        cleanup();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};
