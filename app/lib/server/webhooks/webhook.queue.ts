/**
 * File: app/lib/server/webhooks/webhook.queue.ts
 * Purpose: Enqueue persisted webhook events for asynchronous processing.
 */
import { Queue } from "bullmq";
import { WEBHOOK_QUEUE_NAME } from "../../../../server/config/queue-names.js";
import { queueConnection } from "../../../../server/queues/connection.js";
import type { WebhookQueueJobData } from "./webhook.types.js";

export const webhookQueue = new Queue<WebhookQueueJobData>(WEBHOOK_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5,
    removeOnComplete: 1000,
    removeOnFail: 1000,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

export async function enqueueWebhookEvent(
  data: WebhookQueueJobData,
): Promise<void> {
  await webhookQueue.add("process", data, {
    jobId: data.webhookEventId,
  });
}
