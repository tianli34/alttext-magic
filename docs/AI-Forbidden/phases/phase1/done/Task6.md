已完成 Task 6，Webhook 现在走的是“鉴权 -> 幂等落库 -> 入队 -> 立即 `200` -> worker 异步处理”的链路。

关键改动在 [webhooks.tsx](E:/alttext-magic/app/routes/webhooks.tsx#L1)、[webhook-receive.service.ts](E:/alttext-magic/app/lib/server/webhooks/webhook-receive.service.ts#L1)、[webhook.repository.ts](E:/alttext-magic/app/lib/server/webhooks/webhook.repository.ts#L1)、[webhook.queue.ts](E:/alttext-magic/app/lib/server/webhooks/webhook.queue.ts#L1)、[webhook-process.service.ts](E:/alttext-magic/app/lib/server/webhooks/webhook-process.service.ts#L1)、[worker/index.ts](E:/alttext-magic/worker/index.ts#L1)、[connection.ts](E:/alttext-magic/server/queues/connection.ts#L1)、[queue-names.ts](E:/alttext-magic/server/config/queue-names.ts#L1)。`docs/STATUS.md` 也已更新：[STATUS.md](E:/alttext-magic/docs/STATUS.md#L1)。

精确流程如下：
1. HTTP 命中 [webhooks.tsx](E:/alttext-magic/app/routes/webhooks.tsx#L10)，直接调用 `authenticate.webhook(request)`，在认证前不解析 body。
2. Shopify 校验通过后提取 `shop/topic/webhookId/apiVersion/payload`。
3. `receiveWebhook()` 在 [webhook-receive.service.ts](E:/alttext-magic/app/lib/server/webhooks/webhook-receive.service.ts#L14) 里先记录结构化日志，再调用仓储层。
4. `createWebhookEventIfAbsent()` 在 [webhook.repository.ts](E:/alttext-magic/app/lib/server/webhooks/webhook.repository.ts#L12) 用 `shopify_webhook_id` 唯一键创建 `webhook_events`；如果命中唯一约束，则判定为重复事件。
5. 新事件才会通过 [webhook.queue.ts](E:/alttext-magic/app/lib/server/webhooks/webhook.queue.ts#L23) 入 BullMQ；重复事件不会重复入队，但 HTTP 仍返回 `200`。
6. `worker/index.ts` 在 [worker/index.ts](E:/alttext-magic/worker/index.ts#L18) 消费队列，按 `webhookEventId` 加载持久化事件。
7. `processWebhookEvent()` 在 [webhook-process.service.ts](E:/alttext-magic/app/lib/server/webhooks/webhook-process.service.ts#L23) 里先把状态改为 `PROCESSING` 并递增 `attempts`。
8. 处理规则：
   - `APP_UNINSTALLED`：更新 `shops.uninstalled_at`
   - GDPR topics：占位 no-op
   - 其他 Phase 1 topics：占位 no-op
9. 成功则写回 `status=PROCESSED`、`processed_at`；失败则写回 `status=FAILED`、`error_message`。

验证结果：
- `pnpm typecheck` 通过
- `pnpm.cmd build:worker` 通过

补充说明：
- 现有 `webhooks.app.uninstalled.tsx`、`webhooks.app.gdpr.$.tsx`、`webhooks.app.scopes_update.tsx` 也已改成复用同一接收链路，避免 webhook 处理分叉。
- `pnpm.cmd build:worker` 过程中有一个本机 `pnpm` 用户目录配置读取 warning，但不影响构建成功。