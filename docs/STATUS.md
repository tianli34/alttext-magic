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
