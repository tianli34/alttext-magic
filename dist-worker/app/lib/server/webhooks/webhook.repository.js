import prisma from "../../../../server/db/prisma.server";
import { createLogger } from "../../../../server/utils/logger";
const logger = createLogger({ module: "webhook-repository" });
/**
 * 幂等写入：若 shopifyWebhookId 已存在则直接返回已有记录。
 *
 * 利用 Prisma unique constraint 冲突实现原子去重，
 * 保证并发重放也仅产生一行。
 */
export async function createWebhookEventIfAbsent(envelope) {
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
                payload: payload,
                status: "PENDING",
            },
            select: { id: true },
        });
        logger.info({ shop, topic, webhookId, eventId: event.id }, "webhook.repository.created");
        return { isNew: true, eventId: event.id };
    }
    catch (error) {
        // Prisma unique constraint violation (P2002) → 幂等返回
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "P2002") {
            const existing = await prisma.webhookEvent.findUnique({
                where: { shopifyWebhookId: webhookId },
                select: { id: true },
            });
            if (existing) {
                logger.info({ shop, topic, webhookId, eventId: existing.id }, "webhook.repository.duplicate");
                return { isNew: false, eventId: existing.id };
            }
        }
        throw error;
    }
}
