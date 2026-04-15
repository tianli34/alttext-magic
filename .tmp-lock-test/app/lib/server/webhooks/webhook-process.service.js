/**
 * File: app/lib/server/webhooks/webhook-process.service.ts
 * Purpose: Worker 端消费 WebhookEvent 的业务处理入口。
 * 根据 topic 分发到对应的业务模块（scan / gdpr / scope 等）。
 */
import prisma from "../../../../server/db/prisma.server";
import { createLogger } from "../../../../server/utils/logger";
const logger = createLogger({ module: "webhook-process" });
/**
 * 处理单个 WebhookEvent。
 *
 * 1. 从 DB 读取事件
 * 2. 标记为 PROCESSING
 * 3. 按 topic 分发到对应业务模块
 * 4. 成功 → 标记 PROCESSED；失败 → 递增 attempts、记录 errorMessage
 */
export async function processWebhookEvent(webhookEventId) {
    const event = await prisma.webhookEvent.findUnique({
        where: { id: webhookEventId },
    });
    if (!event) {
        logger.warn({ webhookEventId }, "webhook.process.event_not_found");
        return;
    }
    // 已处理或已合并的事件跳过
    if (event.status === "PROCESSED" || event.coalescedIntoEventId) {
        logger.info({ webhookEventId, status: event.status }, "webhook.process.skipped");
        return;
    }
    // 标记为处理中
    await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
            status: "PROCESSING",
            processingStartedAt: new Date(),
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
        },
    });
    try {
        await dispatchByTopic(event);
        await prisma.webhookEvent.update({
            where: { id: webhookEventId },
            data: {
                status: "PROCESSED",
                processedAt: new Date(),
            },
        });
        logger.info({ webhookEventId, topic: event.topic }, "webhook.process.completed");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.webhookEvent.update({
            where: { id: webhookEventId },
            data: {
                status: "PENDING",
                errorMessage: message,
            },
        });
        logger.error({ webhookEventId, topic: event.topic, err: error }, "webhook.process.failed");
        throw error;
    }
}
/**
 * 根据 topic 分发到对应业务处理器。
 * TODO: 接入各业务模块（scan-continuous / gdpr / scope-update 等）
 */
async function dispatchByTopic(event) {
    logger.info({
        webhookEventId: event.id,
        topic: event.topic,
        shopDomain: event.shopDomain,
    }, "webhook.process.dispatch");
    // 后续按 topic 路由到具体业务:
    // - PRODUCTS_CREATE / PRODUCTS_UPDATE → continuous scan
    // - COLLECTIONS_CREATE / COLLECTIONS_UPDATE → continuous scan
    // - APP_SCOPES_UPDATE → scope sync
    // - APP_UNINSTALLED → gdpr / cleanup
    // - CUSTOMERS_DATA_REQUEST / CUSTOMERS_REDACT / SHOP_REDACT → gdpr
}
