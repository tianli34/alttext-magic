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
