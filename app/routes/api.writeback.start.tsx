/**
 * File: app/routes/api.writeback.start.tsx
 * Purpose: POST /api/writeback/start —— 校验候选并启动 Shopify Alt 写回批次。
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  startWriteback,
  WritebackStartError,
} from "../../server/modules/writeback/writeback.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.writeback.start" });

const writebackStartBodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).optional(),
  altCandidateIds: z.array(z.string().min(1)).min(1).optional(),
}).refine(
  (body) => body.candidateIds !== undefined || body.altCandidateIds !== undefined,
  {
    message: "candidateIds is required",
    path: ["candidateIds"],
  },
);

export const loader = () => {
  return Response.json(
    { error: "Method not allowed. Use POST." },
    { status: 405 },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 未捕获异常统一转 JSON 500：框架对资源路由异常的兜底是 HTML 错误页，
  // 前端 .json() 解析时会抛浏览器原生 JSON.parse 报错，掩盖真实故障
  try {
    return await handleWritebackStart(request);
  } catch (error) {
    // 鉴权会话失效时 shopify 适配层抛出的是 Response（401/重定向），原样放行
    if (error instanceof Response) throw error;
    logger.error({ err: error }, "Writeback start 未捕获异常");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
};

async function handleWritebackStart(request: Request): Promise<Response> {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for writeback start");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const parsed = await parseRequestBody(request);
  if (parsed instanceof Response) return parsed;

  const rawCandidateIds = parsed.candidateIds ?? parsed.altCandidateIds ?? [];
  const candidateIds = Array.from(new Set(rawCandidateIds));

  try {
    const result = await startWriteback(shop.id, candidateIds);
    return Response.json(result);
  } catch (error) {
    if (error instanceof WritebackStartError) {
      if (
        error.code === "WRITEBACK_LOCK_ACTIVE" ||
        error.code === "SCAN_LOCK_ACTIVE"
      ) {
        return Response.json(
          {
            error: "LOCK_CONFLICT",
            code: error.code,
            message: error.message,
            rejected: error.rejected,
          },
          { status: 409 },
        );
      }

      return Response.json(
        {
          error: "VALIDATION_FAILED",
          code: error.code,
          message: error.message,
          rejected: error.rejected,
        },
        { status: 400 },
      );
    }

    logger.error({ shopId: shop.id, err: error }, "Writeback start failed");
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

async function parseRequestBody(
  request: Request,
): Promise<z.infer<typeof writebackStartBodySchema> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    return writebackStartBodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid request body",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
