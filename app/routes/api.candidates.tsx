/**
 * File: app/routes/api.candidates.tsx
 * Purpose: GET /api/candidates —— 返回 scope 内候选图片列表，支持过滤与游标分页。
 */
import { CandidateGroupType } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  candidateListStatusValues,
  isCandidateGroupType,
  listCandidates,
  normalizeCandidateListLimit,
  type CandidateListQuery,
} from "../../server/modules/candidate/candidate-list.server";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.candidates" });

const querySchema = z.object({
  group: z
    .string()
    .optional()
    .refine((value) => value === undefined || isCandidateGroupType(value), {
      message: "Invalid group",
    }),
  status: z.enum(candidateListStatusValues).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

function parseCandidateListQuery(request: Request): CandidateListQuery {
  const url = new URL(request.url);
  const parsed = querySchema.parse({
    group: url.searchParams.get("group") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

  return {
    group: parsed.group as CandidateGroupType | undefined,
    status: parsed.status,
    cursor: parsed.cursor,
    limit: normalizeCandidateListLimit(parsed.limit),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let query: CandidateListQuery;
  try {
    query = parseCandidateListQuery(request);
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
    logger.warn({ shopDomain }, "Shop not found for candidate list");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const data = await listCandidates(shop.id, query);

  return Response.json(data);
};
