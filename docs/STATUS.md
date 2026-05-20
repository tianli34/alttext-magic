# Completed

## 数据层
- Prisma 已有 `GenerationBatch`、`AltDraft`，作为 Phase 7 审阅列表数据源。
- 扫描 + Candidate Management 闭环已就绪。
## AI 生成闭环
- 批量生成管线已完成，draft 已落库；Phase 7 直接消费。
- 关键代码：`worker/processors/generate-alt.processor.ts`、`server/modules/generation/generation-batch.service.ts`。
## Shopify 能力
- 限流器：`server/shopify/shopify-rate-limiter.server.ts`（写回需复用）。
- 按 `alt_plane` 读线上 Alt：`server/modules/generation/truth-check.service.ts`。
- 映射：`FILE_ALT`→MediaImage / `COLLECTION_IMAGE_ALT`→Collection / `ARTICLE_IMAGE_ALT`→Article。
## 前端
- 入口页 `app.candidates.tsx` 可扩展为审阅/编辑页。
- 生成流程 UI 已完成（`useGenerationFlow.ts`、`GenerationFlow.tsx`），无需重做。

## Phase 7：审阅编辑与写回

### Task 7.1 — 数据模型扩展与迁移
经审查，Phase 6 已提前建好写回与审计所需的全部数据模型，无需新增迁移：

### Task 7.2 — 草稿编辑 API
- 路由：`app/routes/api.draft.update.tsx` — `POST /api/draft/update`
- 服务：`server/modules/generation/draft.service.ts` — `updateDraftEditedText()`
- 校验：Session 鉴权、candidateId 归属 shop、status ∈ {GENERATED, WRITEBACK_FAILED_RETRYABLE}、editedText ≤ 512 且非纯空白
- 错误类型：`DraftUpdateError`（CANDIDATE_NOT_FOUND / NO_DRAFT / INVALID_STATUS）

### Task 7.3 — 审阅列表后端 API
- 路由：`app/routes/api.candidates.review.tsx` — `GET /api/candidates/review`
- 服务：`server/modules/candidate/review-list.server.ts` — `listReviewCandidates()`
- Query 参数：status / altPlane / page / pageSize / sortBy
- 返回：candidate + target + draft 组合视图，含 displayText / isSharedFile 派生字段，分页 meta { total, page, pageSize, totalPages }

### Task 7.4 — 审阅列表前端页面
- 路由：`app/routes/app.review.tsx` — `/app/review`
- 已接入审阅列表、筛选、分页、草稿编辑保存、装饰性切换、共享文件提示与批量写回入口。

### Task 7.5 — WritebackRouter 与 Mutation Executors
- 服务：`server/modules/writeback/writeback-router.ts`，按 `AltPlane` 路由到 File / Collection / Article executor。
- Executors：已实现 `fileUpdate`、`collectionUpdate`、`articleUpdate` 写回、`userErrors` 解析、网络错误可重试分类。

### Task 7.6 — WRITEBACK 锁管理
- 服务：`server/modules/lock/writeback-lock.service.ts` — 基于 Redis 的 WRITEBACK 写回锁。
- API：`acquireWritebackLock(shopId, ttlMs)` / `releaseWritebackLock(shopId, lockId)` / `isWritebackLocked(shopId)`。
- 锁 key：`shop:{shopId}:lock:writeback`，value 存 UUID lockId，默认 TTL 5 分钟，Redis `SET NX PX` 原子获取。
- 互斥：WRITEBACK 锁获取前检查 PG SCAN 锁（`isOperationRunning`），SCAN 锁获取前检查 Redis WRITEBACK 锁（`isWritebackLocked`）。
- 扩展：`server/modules/lock/operation-lock.service.ts` 新增 `isOperationRunning(shopId, operationType)`。
- 路由：`app/routes/api.scan.start.tsx`

### Task 7.7 — 写回启动 API
- 路由：`app/routes/api.writeback.start.tsx` — `POST /api/writeback/start`
- 服务：`server/modules/writeback/writeback.service.ts` — 校验候选、获取 WRITEBACK 锁、创建 `JobBatch(type=WRITEBACK)` + `JobItem`、投递 `writeback` BullMQ job。
- 队列：`server/queues/writeback.queue.ts`，queue name = `writeback`，payload 含 shopId / candidateId / batchId / lockId / altPlane / shopifyGid / altText。

### Task 7.8 — 写回二次确认弹窗
- 组件：`app/components/review/WritebackConfirmModal.tsx` + `WritebackConfirmModal.module.css`
- 确认后：调用 `POST /api/writeback/start`
- 审阅页面对接：`app/routes/app.review.tsx` 新增 `showWritebackModal` 状态、`writebackConfirmItems` 计算、`openWritebackModal` / `closeWritebackModal` / `confirmWriteback` 回调

### Task 7.9 — Writeback Job 完整流水线
- Worker 已注册 `writeback` queue：`worker/index.ts`，并发默认 3，`WRITEBACK_CONCURRENCY` 最大 5。
- Processor：`worker/processors/writeback.processor.ts`，已实现二次读校验、路由写回、成功/跳过/失败落库、审计、batch 收尾与 WRITEBACK 锁释放。

### Task 7.10 — SSE 写回进度推送
- 路由：`app/routes/api.writeback.progress.tsx` — `GET /api/writeback/progress?batchId=...`，校验 shop 归属后以 DB 轮询推送 progress/complete SSE。
- 前端：`app/hooks/useWritebackSSE.ts` + `app/routes/app.review.tsx`，写回启动后展示实时进度，刷新可通过 `batchId` 恢复。

### Task 7.11 — 失败项展示与重试
- 审阅接口返回 `errorMessage` 与失败重试次数；审阅页展示失败项、错误原因、单条/全部重试入口，复用 `/api/writeback/start`。

### Task 7.12 — 写回完成汇总页面
- 路由：`app/routes/api.writeback.batch.$batchId.tsx` 返回批次详情、分类统计与耗时；审阅页在 complete 后展示成功/跳过/失败汇总与 History 入口。

### Task 7.13 — 审计历史 API 与页面
- 路由：`app/routes/api.history.tsx` — `GET /api/history` 支持 page/pageSize/altPlane/from/to，默认最近 90 天。
- 页面：`app/routes/app.history.tsx` 展示写回记录、类型筛选、分页与空状态。
