/**
 * File: server/modules/notice/scan-notice-ack.service.ts
 * Purpose: Manage scan notice acknowledgements per shop, enforcing version-based
 * gating so that updated notices always require re-confirmation.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
import type { AckNoticeInput, NoticeStatusResult } from "./notice.types";

const logger = createLogger({ module: "scan-notice-ack" });

/**
 * Acknowledge (confirm) a scan notice for a given shop.
 *
 * Uses upsert on the unique (shopId, noticeVersion) constraint so that
 * re-acknowledging the same version is idempotent.
 *
 * @param input - Acknowledgement payload including shop, version, and scope snapshot.
 */
export async function ackNotice(input: AckNoticeInput): Promise<void> {
  const { shopId, noticeKey, version, scopeFlagsSnapshot, actor } = input;

  logger.info(
    { shopId, noticeKey, version, actor },
    "Acknowledging scan notice",
  );

  await prisma.scanNoticeAck.upsert({
    where: {
      shopId_noticeVersion: { shopId, noticeVersion: version },
    },
    create: {
      shopId,
      noticeVersion: version,
      scopeFlagsSnapshot: scopeFlagsSnapshot as unknown as Prisma.InputJsonValue,
    },
    update: {
      scopeFlagsSnapshot: scopeFlagsSnapshot as unknown as Prisma.InputJsonValue,
      acknowledgedAt: new Date(),
    },
  });
}

/**
 * Check whether a shop needs to acknowledge the current notice version.
 *
 * Logic:
 * - No record found  → needsNoticeAck = true  (fresh shop)
 * - Different version → needsNoticeAck = true  (stale acknowledgement)
 * - Same version      → needsNoticeAck = false (already confirmed)
 *
 * @param shopId         - The shop's internal database ID.
 * @param currentVersion - The version string the app currently expects (e.g. from constants).
 * @returns A {@link NoticeStatusResult} describing the acknowledgement state.
 */
export async function getNoticeStatus(
  shopId: string,
  currentVersion: string,
): Promise<NoticeStatusResult> {
  const ack = await prisma.scanNoticeAck.findUnique({
    where: {
      shopId_noticeVersion: { shopId, noticeVersion: currentVersion },
    },
    select: { noticeVersion: true },
  });

  if (!ack) {
    return {
      needsNoticeAck: true,
      acknowledgedVersion: null,
      currentVersion,
    };
  }

  return {
    needsNoticeAck: false,
    acknowledgedVersion: ack.noticeVersion,
    currentVersion,
  };
}

// ──────────────────────────────────────────────────────────
// Pure logic helpers (exported for unit testing without DB)
// ──────────────────────────────────────────────────────────

/**
 * Pure version check: determine if acknowledgement is needed given
 * the acknowledged version and the current expected version.
 *
 * Exported so that version-check logic can be unit-tested without
 * any database dependency.
 */
export function checkNeedsAck(
  acknowledgedVersion: string | null | undefined,
  currentVersion: string,
): boolean {
  return acknowledgedVersion !== currentVersion;
}
