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
- Task 8-C2：`server/services/gates/lockGate.ts` 实现 checkScanLock + delayJobForLock（SCAN 锁互斥门控，moveToDelayed 重试，超限标记 FAILED）。
- Task 8-C3：`server/services/gates/planGate.ts` 实现 checkIncrementalEnabled（查询 active 订阅的 incrementalScanEnabled，Free 返回 false 付费返回 true）。
- Task 8-C4：`server/services/gates/scopeGate.ts` 实现 checkScopeForTopic（topic→resourceType 映射，查询 shops.scan_scope_flags，scope 关闭返回 false）。
- Task 8-C5：`server/services/gates/fingerprintGate.ts` 实现 checkFingerprintChange（调用 fingerprintRepo.compareAndDecide，相同指纹返回 UNCHANGED → 调用方标记 SKIPPED_NO_IMAGE_CHANGE）。
- Task 8-C6：`shops.incremental_scan_enabled` 冗余字段 + 计划升降级联动。Prisma 迁移新增字段含回填；apply-subscription-change / plan-change / subscription.service 三处双写（billingSubscription + shop）；planGate 改为直接读取 shops 表避免联表；单测覆盖 Free→Paid / Paid→Free 联动（63/63 通过）。
- Task 8-D1：`getProductMedia.ts` 实现单个 Product 全部 MediaImage 读取，含游标分页，空 media 返回 `[]`。
- Task 8-D2：共享收敛模块 `productConvergence.ts` 实现，全量发布 `publish.service.ts` 重构并完美复用该纯函数收敛规则。
- Task 8-D3：`continuous_scan_product` Worker 与处理器实现完成，已完整集成到统一 Worker 架构并支持多级门控验证与事务性收敛。
- Task 8-E1：`getCollectionImage.ts` 实现单个 Collection 封面图读取，无图返回 null。
- Task 8-E2：共享收敛模块 `collectionConvergence.ts` 实现，全量发布 `publish.service.ts` 重构第 3 阶段（COLLECTION_IMAGE）改为循环调用 convergeCollection。
