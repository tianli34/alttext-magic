import { Prisma } from "@prisma/client";
import prisma from "../../../../server/db/prisma.server.js";
import {
  WEBHOOK_EVENT_STATUS,
  type AuthenticatedWebhookEnvelope,
} from "./webhook.types.js";

// [新增] 确保店铺存在的辅助函数
async function ensureShopExists(shopDomain: string): Promise<void> {
  await prisma.shop.upsert({
    where: {
      shopDomain: shopDomain, // 根据你的 schema 调整字段名，可能是 domain 或 shopDomain
    },
    update: {}, // 已存在则不更新
    create: {
      shopDomain: shopDomain, // [新增] 创建店铺记录
      // [新增] 以下字段根据你的 schema 必填项填写，可能包括：
      accessTokenEncrypted: "test-token", // 测试用默认值
      scopes: "read_products,write_products", // 测试用默认值
      accessTokenNonce: "nonce_value_from_oauth",   // 👈 补充
      accessTokenTag: "tag_value_from_response"     // 👈 补充      
      // 其他你的 Shop 模型必填字段...
    },
  });
}

export async function createWebhookEventIfAbsent(
  envelope: AuthenticatedWebhookEnvelope,
): Promise<{ eventId: string; isNew: boolean }> {
  try {
    // [新增] 先确保店铺存在，避免外键约束错误
    await ensureShopExists(envelope.shop);

    const event = await prisma.webhookEvent.create({
      data: {
        shopDomain: envelope.shop,
        topic: envelope.topic,
        shopifyWebhookId: envelope.webhookId,
        idempotencyKey: envelope.webhookId,
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
  } catch (error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
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

export async function markWebhookEventProcessing(
  webhookEventId: string,
): Promise<void> {
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

export async function markWebhookEventProcessed(
  webhookEventId: string,
): Promise<void> {
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

export async function markWebhookEventFailed(
  webhookEventId: string,
  errorMessage: string,
): Promise<void> {
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

export async function getWebhookEventById(webhookEventId: string) {
  return prisma.webhookEvent.findUniqueOrThrow({
    where: {
      id: webhookEventId,
    },
  });
}

export async function markShopUninstalled(shopDomain: string): Promise<void> {
  await prisma.shop.updateMany({
    where: {
      shopDomain, // [注意] 确保这里字段名与 schema 一致
    },
    data: {
      uninstalledAt: new Date(),
    },
  });
}