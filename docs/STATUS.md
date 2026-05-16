# Completed

## 1. 数据与候选基础
- 数据库底层结构就绪。
- 图片扫描与 Candidate Management 已闭环，可直接提取待生成候选数据。

## 2. 额度管控系统（与 Phase 6 强对接）
系统已具备完整的额度查询、预留与扣除能力，核心对接点如下：
- 数据表：`credit_bucket` / `credit_reservation` / `credit_reservation_line`
- 余额查询：`credit-balance.server.ts`
- 预留与核销服务：`app/services/credits/credit-reservation.server.ts` 提供批量的 `reserve`、`consume`、`release` 方法
- 预检接口：`POST /api/generation/preflight`

## Phase 6：AI 生成管线
### Task 6.1 — 数据库 Schema 扩展：`generation_batch` + `alt_draft`
`prisma/schema.prisma` — 新增 `GenerationBatch` 模型及其 `GenerationBatchStatus` 枚举，更新 `AltDraft` 关联
### Task 6.2 — AI Gateway 服务：统一抽象层 + Fake Provider + 主/副模型切换
- `server/ai/ai.types.ts` — `GenerateAltRequest`、`GenerateAltResult`、`AIGenerationError`、`AIProvider` 接口
- `server/ai/providers/fake.provider.ts``trigger-fake-failure` / `trigger-fake-delay` 特殊 URL 支持
- `server/ai/providers/openai.provider.ts`
- `server/ai/providers/fallback.provider.ts`
- `server/ai/ai-gateway.ts` — `AIGatewayService` 单例门面，`AI_PROVIDER=fake` 走 Fake，否则走真实主/副链
- `server/config/env.ts` — 新增 `AI_PROVIDER`、`AI_PRIMARY_*`、`AI_FALLBACK_*`
### Task 6.3 — Prompt 模板系统 + AI 输出清洗器
- `server/ai/prompt-engine.server.ts` — 实现 `buildPrompt`，支持 `RESOURCE_SPECIFIC`、`FILE_NEUTRAL`、`SHARED_NEUTRAL`
- `server/ai/output-cleaner.server.ts` — 实现 `cleanAltText`
### Task 6.4 — 真值复核服务：按 `alt_plane` 读取 Shopify 线上当前 Alt
- `server/shopify/shopify-rate-limiter.server.ts` — `TokenBucket` + `getShopifyRateLimiter`（进程内按 shopId 隔离单例，扫描与生成管线共用）
- `server/modules/generation/truth-check.service.ts` — `TruthCheckService.checkCurrentAlt`；按 `alt_plane` 分类查询：`FILE_ALT`→MediaImage、`COLLECTION_IMAGE_ALT`→Collection、`ARTICLE_IMAGE_ALT`→Article；`TruthCheckRetryableError` 区分可重试错误
### Task 6.5 — 上下文构建服务：usage 统计 + `context_mode` 判定 + `context_snapshot` 生成
- `server/modules/generation/context-builder.service.ts` — `ContextBuilderService.buildContext`；查询 `image_usage` 判定引用状态，根据 §4.3.10 返回 `RESOURCE_SPECIFIC`、`FILE_NEUTRAL` 或 `SHARED_NEUTRAL` 及其对应的 `context_snapshot`
### Task 6.6 — GENERATE 锁管理服务
- `server/modules/lock/generate-lock.service.ts` — 基于 `operation-lock.service.ts` 封装 GENERATE 操作锁的 acquire, heartbeat, release 逻辑。
- `app/routes/api.scan.start.tsx` & `app/routes/api.generation.start.tsx` — 扫描/生成启动接口检查 SCAN / GENERATE 锁冲突并返回 409。
### Task 6.7 — `generate_alt` BullMQ Job 实现
- `server/queues/generate-alt.queue.ts`、`worker/processors/generate-alt.processor.ts`、`worker/index.ts` — 注册并处理单条候选生成 Job，串联真值复核、上下文、AI、draft、单条额度结算与进度事件。
- `server/modules/generation/generation-credit.service.ts` — 支持 candidate 粒度 consume/release 幂等结算。
- `tests/generate-alt.processor.test.ts` — 覆盖 5 条成功、真值跳过、fallback、全部失败、重复 Job 幂等。
### Task 6.8 — Batch 生命周期管理
- `server/modules/generation/generation-batch.service.ts` — 创建 generation_batch、按 Job 完成递增进度、完成后释放未使用预留并释放 GENERATE 锁；提供超时失败兜底。
- `app/routes/api.generation.start.tsx` — 生成启动串联 batch、GENERATE 锁、额度预留、进度初始化与 generate_alt 入列。
