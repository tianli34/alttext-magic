# Completed

- Shopify 限流：`shopify-rate-limiter.server.ts` 已实现；`alt_plane` 映射：FILE_ALT→MediaImage / COLLECTION_IMAGE_ALT→Collection / ARTICLE_IMAGE_ALT→Article。
- Truth Check：`truth-check.service.ts` 按 `alt_plane` 读线上 Alt，可复用于增量变更时的指纹比对。
- AI 生成管线：批量生成已完成，`AIGatewayService` 统一路由 + `FallbackProvider` 多级降级。
- 写回流水线：BullMQ `writeback` 队列 → `WritebackRouter` 路由到 file/collection/article executor，成功/跳过/失败落库审计。
- 锁机制：Redis `writeback-lock.service.ts`（SET NX PX）与 PG SCAN 锁互斥（`isOperationRunning`），Phase 8 需同样防冲突。
- BullMQ 基础设施：队列 + processor + SSE 进度推送模式已建立，可复用于 Webhook 事件处理队列。
- 审计与历史：`GET /api/history` + 前端历史页已完成，增量扫描结果可接入现有审计链路。

## Phase 8 任务拆解 — 增量扫描与 Webhook 驱动

- Task 8-A1：`continuous-scan` 队列 + 三类 Job 类型定义 + 入队工具函数已创建。
- Task 8-A2：`debounce.service.ts` 实现 key/tryAcquire/update/consume 四个函数。
- Task 8-B1：`webhook-event.service.ts` 实现 products/update、collections/update 的 debounce 路由（tryAcquire/update + COALESCED 标记 + delayed job 入队）。
- Task 8-A3：`imageFingerprint.ts` 实现 computeProductFingerprint / computeCollectionFingerprint。
- Task 8-A4：`fingerprintRepo.ts` 实现 get/upsert/compareAndDecide。
- Task 8-C1：`continuous-scan-debounce.processor.ts` 实现 consume → 按 topic 分发到 product/collection 入队。
