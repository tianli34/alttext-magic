/**
 * File: server/modules/webhook/webhook-topic-registry.ts
 * Purpose: Webhook topic 处理器注册表。
 * webhook 模块只依赖本注册表做分发，不直接 import 业务模块（scan/billing/continuous 等），
 * 由 worker 启动时调用各业务模块的注册入口完成绑定，实现依赖反转。
 */

export interface WebhookTopicHandlerInput {
  shopDomain: string;
  payload: unknown;
}

export type WebhookTopicHandler = (
  input: WebhookTopicHandlerInput,
) => Promise<void>;

const handlers = new Map<string, WebhookTopicHandler>();

/** topic 归一化: 大写 + "/" → "_"，与 dispatchByTopic 的归一化规则保持一致。 */
export function normalizeWebhookTopic(topic: string): string {
  return topic.toUpperCase().replace(/\//g, "_");
}

/** 注册 topic 处理器（同 topic 重复注册时覆盖旧处理器）。 */
export function registerWebhookTopicHandler(
  topic: string,
  handler: WebhookTopicHandler,
): void {
  handlers.set(normalizeWebhookTopic(topic), handler);
}

/** 按归一化 topic 查询处理器，未注册时返回 undefined。 */
export function getWebhookTopicHandler(
  topic: string,
): WebhookTopicHandler | undefined {
  return handlers.get(normalizeWebhookTopic(topic));
}
