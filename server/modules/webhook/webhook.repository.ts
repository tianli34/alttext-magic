/**
 * File: app/lib/server/webhooks/webhook.repository.ts
 * Purpose: 幂等持久化 WebhookEvent 到数据库。
 * 仅执行: 按 shopifyWebhookId 唯一约束去重 → insert 或返回已有行。
 */
import type { Prisma } from "@prisma/client";
import prisma from "../../../../server/db/prisma.server";
import { createLogger } from "../../../../server/utils/logger";
import type {
  ReceiveWebhookEnvelope,
  WebhookReceipt,
} from "./webhook.types";

const logger = createLogger({ module: "webhook-repository" });

/**
 * 幂等写入：若 shopifyWebhookId 已存在则直接返回已有记录。
 *
 * 利用 Prisma unique constraint 冲突实现原子去重，
 * 保证并发重放也仅产生一行。
 */
export async function createWebhookEventIfAbsent(
  envelope: ReceiveWebhookEnvelope,
): Promise<WebhookReceipt> {
  const { shop, topic, webhookId, apiVersion, payload } = envelope;
  const idempotencyKey = `${shop}:${webhookId}`;

  try {
    const event = await prisma.webhookEvent.create({
      data: {
        shopDomain: shop,
        topic,
        shopifyWebhookId: webhookId,
        idempotencyKey,
        apiVersion: apiVersion ?? null,
        payload: payload as Prisma.InputJsonValue,
        status: "PENDING",
      },
      select: { id: true },
    });

    logger.info(
      { shop, topic, webhookId, eventId: event.id },
      "webhook.repository.created",
    );

    return { isNew: true, eventId: event.id };
  } catch (error: unknown) {
    // Prisma unique constraint violation (P2002) → 幂等返回
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: webhookId },
        select: { id: true },
      });

      if (existing) {
        logger.info(
          { shop, topic, webhookId, eventId: existing.id },
          "webhook.repository.duplicate",
        );
        return { isNew: false, eventId: existing.id };
      }
    }

    throw error;
  }
}
