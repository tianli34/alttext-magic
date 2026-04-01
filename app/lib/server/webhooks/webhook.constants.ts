/**
 * File: app/lib/server/webhooks/webhook.constants.ts
 * Purpose: Centralize webhook topic classification for the Phase 1 pipeline.
 */
import { GDPR_TOPICS, PHASE1_WEBHOOK_TOPICS } from "./webhook.types.js";

const gdprTopicSet = new Set<string>(GDPR_TOPICS);
const phase1TopicSet = new Set<string>(PHASE1_WEBHOOK_TOPICS);

export function isPhase1WebhookTopic(topic: string): boolean {
  return phase1TopicSet.has(topic);
}

export function isGdprTopic(topic: string): boolean {
  return gdprTopicSet.has(topic);
}
