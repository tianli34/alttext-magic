/**
 * File: app/routes/api.scan.stop.tsx
 * Purpose: POST /api/scan/stop —— 停止尚未开始执行的扫描。
 *          仅支持 task 全部仍为 PENDING 的场景，避免中途打断已提交的 Shopify bulk。
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { stopPendingScanJob } from "../../server/modules/scan/catalog/scan-job.service";

const bodySchema = z.object({
  scanJobId: z.string().min(1),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const result = await stopPendingScanJob(parsed.scanJobId, shop.id);

  if (!result.ok) {
    if (result.reason === "NOT_FOUND") {
      return Response.json({ error: "Scan job not found" }, { status: 404 });
    }

    if (result.reason === "NOT_RUNNING") {
      return Response.json({ error: "当前扫描不在运行中" }, { status: 409 });
    }

    return Response.json(
      { error: "扫描已经开始执行，暂不支持中途停止" },
      { status: 409 },
    );
  }

  return Response.json({ ok: true });
};
