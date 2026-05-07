/**
 * File: app/routes/api.candidates.$id.usages.tsx
 * Purpose: GET /api/candidates/:altCandidateId/usages —— 返回指定候选的所有 PRESENT usage 位置。
 */
import { CandidateGroupType } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { isCandidateGroupType } from "../../server/modules/candidate/candidate-list.server";
import { listCandidateUsages } from "../../server/modules/candidate/candidate-usage.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.candidates.usages" });

const querySchema = z.object({
  group: z
    .string()
    .optional()
    .refine((value) => value === undefined || isCandidateGroupType(value), {
      message: "Invalid group",
    }),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const altCandidateId = params.id;
  if (!altCandidateId) {
    return Response.json({ error: "Missing candidate ID" }, { status: 400 });
  }

  let group: CandidateGroupType | undefined;
  try {
    const url = new URL(request.url);
    const parsed = querySchema.parse({
      group: url.searchParams.get("group") ?? undefined,
    });
    group = parsed.group as CandidateGroupType | undefined;
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return Response.json({ error: "Invalid query", issues }, { status: 400 });
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
    logger.warn({ shopDomain }, "Shop not found for candidate usages");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const data = await listCandidateUsages(shop.id, altCandidateId, group);

  return Response.json(data);
};
