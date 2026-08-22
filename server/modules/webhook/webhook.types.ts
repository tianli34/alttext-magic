/**
 * File: app/lib/server/webhooks/webhook.types.ts
 * Purpose: Define types shared across webhook receive / process / queue layers.
 */
import type { WebhookEventStatus } from "@prisma/client";

/** Webhook 接收入参 — 由 Shopify authenticate.webhook() 解码而来 */
export interface ReceiveWebhookEnvelope {
  shop: string;
  topic: string;
  webhookId: string;
  apiVersion?: string | null;
  payload: unknown;
}

/** createWebhookEventIfAbsent 返回的幂等收据 */
export interface WebhookReceipt {
  /** 是否为新写入（true=首次, false=重复） */
  isNew: boolean;
  /** WebhookEvent 数据库 id */
  eventId: string;
}

/** BullMQ Job Data — 入队时携带的最小载荷 */
export interface WebhookQueueJobData {
  webhookEventId: string;
}

/** WebhookEvent 精简行（供内部查询使用） */
export interface WebhookEventRow {
  id: string;
  shopDomain: string;
  topic: string;
  status: WebhookEventStatus;
  attempts: number;
  shopifyWebhookId: string;
}
