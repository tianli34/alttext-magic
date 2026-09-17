/**
 * File: app/routes/api.dashboard.process.tsx
 * Purpose: POST /api/dashboard/process —— 返回当前扫描范围内可一键处理的候选 ID。
 */
import { AltCandidateStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { mapScopeFlagsToGroupTypes } from "../../server/modules/dashboard/dashboard.service";
import { getScopeSettings } from "../../server/modules/shop/scope.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.dashboard.process" });

export const loader = () => Response.json(
  { error: "Method not allowed. Use POST." },
  { status: 405 },
);

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
    logger.warn({ shopDomain: session.shop }, "Shop not found for dashboard process");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const scopeSettings = await getScopeSettings(shop.id);
  const groupTypes = mapScopeFlagsToGroupTypes(scopeSettings.effectiveReadScopeFlags);
  if (groupTypes.length === 0) {
    return Response.json({ generationCandidateIds: [], writebackCandidateIds: [] });
  }

  const candidates = await prisma.altCandidate.findMany({
    where: {
      shopId: shop.id,
      status: {
        in: [
          AltCandidateStatus.INITIAL,
          AltCandidateStatus.GENERATION_FAILED_RETRYABLE,
          AltCandidateStatus.GENERATED,
          AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
        ],
      },
      altTarget: { currentAltEmpty: true },
      groupProjections: { some: { groupType: { in: groupTypes } } },
    },
    select: {
      id: true,
      status: true,
      altTarget: { select: { decorativeMark: { select: { isActive: true } } } },
    },
  });

  const generationCandidateIds: string[] = [];
  const writebackCandidateIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.altTarget.decorativeMark?.isActive) continue;
    if (
      candidate.status === AltCandidateStatus.INITIAL ||
      candidate.status === AltCandidateStatus.GENERATION_FAILED_RETRYABLE
    ) {
      generationCandidateIds.push(candidate.id);
    } else {
      writebackCandidateIds.push(candidate.id);
    }
  }

  return Response.json({ generationCandidateIds, writebackCandidateIds });
};
