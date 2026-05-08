/**
 * File: app/routes/api.decorative.unmark.tsx
 * Purpose: POST /api/decorative/unmark —— 取消候选图片装饰性标记。
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { unmarkDecorativeCandidate } from "../../server/modules/decorative/decorative-mark.server";
import { DecorativeActionError } from "../../server/modules/decorative/decorative.types";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.decorative.unmark" });

const bodySchema = z.object({
  altCandidateId: z.string().min(1),
});

function issuesFromZod(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return Response.json(
        { error: "Invalid body", issues: issuesFromZod(err) },
        { status: 400 },
      );
    }

    throw err;
  }

  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for decorative unmark");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  try {
    const candidate = await unmarkDecorativeCandidate(shop.id, body.altCandidateId);
    return Response.json({ candidate });
  } catch (err) {
    if (err instanceof DecorativeActionError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }

    throw err;
  }
};
