/**
 * File: app/routes/api.history.tsx
 * Purpose: GET /api/history —— 查询写回审计历史。
 */
import { AltPlane } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  defaultHistoryFrom,
  listWritebackHistory,
} from "../../server/modules/writeback/history.service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_PAGE_SIZE)
    .default(DEFAULT_HISTORY_PAGE_SIZE),
  altPlane: z.nativeEnum(AltPlane).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  let parsed: z.infer<typeof querySchema>;

  try {
    parsed = querySchema.parse({
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
      altPlane: url.searchParams.get("altPlane") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid query",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    throw error;
  }

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const now = new Date();
  const data = await listWritebackHistory(shop.id, {
    page: parsed.page,
    pageSize: parsed.pageSize,
    altPlane: parsed.altPlane,
    from: parsed.from ?? defaultHistoryFrom(now),
    to: parsed.to ?? now,
  });

  return Response.json(data);
};
