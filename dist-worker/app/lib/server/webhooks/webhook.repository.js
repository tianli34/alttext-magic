/**
 * File: app/lib/server/webhooks/webhook.repository.ts
 * Purpose: Encapsulate Prisma access for webhook event persistence and lifecycle updates.
 */
import { Prisma } from "@prisma/client";
import prisma from "../../../../server/db/prisma.server.js";
import { WEBHOOK_EVENT_STATUS, } from "./webhook.types.js";
export async function createWebhookEventIfAbsent(envelope) {
    try {
        const event = await prisma.webhookEvent.create({
            data: {
                shopDomain: envelope.shop,
                topic: envelope.topic,
                shopifyWebhookId: envelope.webhookId,
                apiVersion: envelope.apiVersion,
                payload: envelope.payload,
                status: WEBHOOK_EVENT_STATUS.pending,
            },
            select: {
                id: true,
            },
        });
        return {
            eventId: event.id,
            isNew: true,
        };
    }
    catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002") {
            const existing = await prisma.webhookEvent.findUniqueOrThrow({
                where: {
                    shopifyWebhookId: envelope.webhookId,
                },
                select: {
                    id: true,
                },
            });
            return {
                eventId: existing.id,
                isNew: false,
            };
        }
        throw error;
    }
}
export async function markWebhookEventProcessing(webhookEventId) {
    await prisma.webhookEvent.update({
        where: {
            id: webhookEventId,
        },
        data: {
            status: WEBHOOK_EVENT_STATUS.processing,
            attempts: {
                increment: 1,
            },
            errorMessage: null,
        },
    });
}
export async function markWebhookEventProcessed(webhookEventId) {
    await prisma.webhookEvent.update({
        where: {
            id: webhookEventId,
        },
        data: {
            status: WEBHOOK_EVENT_STATUS.processed,
            processedAt: new Date(),
            errorMessage: null,
        },
    });
}
export async function markWebhookEventFailed(webhookEventId, errorMessage) {
    await prisma.webhookEvent.update({
        where: {
            id: webhookEventId,
        },
        data: {
            status: WEBHOOK_EVENT_STATUS.failed,
            errorMessage,
        },
    });
}
export async function getWebhookEventById(webhookEventId) {
    return prisma.webhookEvent.findUniqueOrThrow({
        where: {
            id: webhookEventId,
        },
    });
}
export async function markShopUninstalled(shopDomain) {
    await prisma.shop.updateMany({
        where: {
            shopDomain,
        },
        data: {
            uninstalledAt: new Date(),
        },
    });
}
