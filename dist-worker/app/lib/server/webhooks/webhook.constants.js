/**
 * File: app/lib/server/webhooks/webhook.constants.ts
 * Purpose: Centralize webhook topic classification for the Phase 1 pipeline.
 */
import { GDPR_TOPICS, PHASE1_WEBHOOK_TOPICS } from "./webhook.types.js";
const gdprTopicSet = new Set(GDPR_TOPICS);
const phase1TopicSet = new Set(PHASE1_WEBHOOK_TOPICS);
export function isPhase1WebhookTopic(topic) {
    return phase1TopicSet.has(topic);
}
export function isGdprTopic(topic) {
    return gdprTopicSet.has(topic);
}
