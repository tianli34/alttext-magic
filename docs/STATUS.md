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
- `server/ai/output-cleaner.server.ts` — 实现 `cleanAltText`，新增 `locale` 参数支持中/英文不同清洗规则
### Task 6.3a — 按店铺 locale 切换中英文 Alt Text 生成
- `server/ai/ai.types.ts` — `GenerateAltRequest` 新增可选 `locale: "en" | "zh-CN"`
- `worker/processors/generate-alt.processor.ts` — 按 `shopId` 判断店铺，`cmnidr9hh0000bsttv2rx99xq` 走中文，其余走英文
- `server/ai/prompt-engine.server.ts` — `buildPrompt` 新增 `locale` 参数，中英文提示词条件切换
- `server/ai/providers/openai.provider.ts` — `buildSystemPrompt` 按 `locale` 输出中/英文 system prompt；用户消息同理
- `server/ai/output-cleaner.server.ts` — `cleanAltText` 新增 `locale` 参数：中文跳英文特定规则，截断至 75 字符
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
- `worker/processors/generate-alt.processor.ts` — catch 兜底：非 `AIGenerationError` 异常也走 `markGenerationFailed`，避免候选人卡在 `GENERATING`（第一道防线）
### Task 6.8 — Batch 生命周期管理
- `server/modules/generation/generation-batch.service.ts` — 创建 generation_batch、按 Job 完成递增进度、完成后释放未使用预留并释放 GENERATE 锁；提供超时失败兜底。
- `server/modules/generation/generation-batch.service.ts` — `finalizeTimedOutBatches` 超时回滚时一并回滚该 shop 下所有 `GENERATING` 候选人到 `GENERATION_FAILED_RETRYABLE`（第二道防线，覆盖进程崩溃等极端场景）
- `app/routes/api.generation.start.tsx` — 生成启动串联 batch、GENERATE 锁、额度预留、进度初始化与 generate_alt 入列。
### Task 6.9 — `POST /api/generation/start` API 端点
- `app/routes/api.generation.start.tsx` — 补齐锁检查、候选/装饰性/effective scope 校验、额度 preflight、预留、batch、Job 投递、`GENERATING` 状态与失败回滚。
### Task 6.10 — SSE 进度推送：生成阶段实时进度
- `server/sse/progress-publisher.ts` — 扩展 `publishGenerationProgress`：写 Redis hash 后通过 `PUBLISH` 推送到 `generation:progress:events:${batchId}` 频道；终态时额外发送 `generation_completed` 汇总事件；新增 `readGenerationProgress` 读取快照。
- `server/sse/generation-sse.service.ts` — 生成阶段 Redis Pub/Sub 订阅式 SSE 服务：连接建立时发送 Redis hash 快照恢复，再订阅频道实时转发；收到 `generation_completed` 后自动关闭流；客户端断开时清理订阅连接（`unsubscribe` + `quit`）。
- `app/routes/api.generation.progress.$batchId.tsx` — `GET /api/generation/progress/:batchId` SSE 端点：Bearer 鉴权 → 校验 batch 归属 shop → 建立 SSE 流。
- `app/hooks/useGenerationSSE.ts` — 前端 Hook：连接生成 SSE 端点，实时接收 `generation_progress` / `generation_completed` 事件，提供 `progress`、`percent`、`isTerminal` 等计算属性。
### Task 6.11 — 前端：生成触发交互流程
实现生成流程状态机 Hook 和相关组件，支持生成过程的预检、确认、进度展示及汇总
`useGenerationFlow.ts` — 生成流程状态机 Hook `GenerationFlow.tsx` — 生成流程 UI 组件 `app.candidates.tsx` — 候选列表页面
### 候选列表修复 — 选择工具栏粘性定位
- `app/components/generation/GenerationFlow.module.css` — `.selectionToolbar` 增加 `position: sticky`，使其跟随页面滚动。

### Task 6.12 — 前端：额度不足阻断与引导
- `app/routes/api.generation.preflight.tsx` — 预检接口增加 `currentPlan` 返回。
- `app/hooks/useGenerationFlow.ts` — 类型定义同步。
- `app/components/generation/GenerationFlow.tsx` — 实现余额不足 Modal 切换、引导 Banner 及 "Upgrade Plan" / "Buy Extra Pack" 跳转逻辑；MAX 计划用户自动隐藏升级按钮。

### Task 6.13 — AI 模型调用耗时记录
- `prisma/schema.prisma` — 新增 `AiModelCall` 模型（`ai_model_call` 表）。
- `server/ai/ai.types.ts` — 新增 `ModelCallRecord` 类型；`GenerateAltResult` 新增 `modelCalls` 字段；`AIGenerationError` 新增可选 `modelCalls` 参数。
- `server/ai/providers/openai.provider.ts` — 计时逻辑：`classifyNetworkError`/`classifyHttpError` 区分 `SERVER`/`NON_SERVER`；成功/失败均通过 `modelCalls` 传递耗时记录。
- `server/ai/providers/fake.provider.ts` — 同步添加计时与 `modelCalls`。
- `server/ai/providers/fallback.provider.ts` — 聚合主/副 provider 的 `modelCalls`，不自行计时。
- `worker/processors/generate-alt.processor.ts` — 新增 `persistModelCalls()` 在成功/失败路径统一写入 `ai_model_call` 表。

## 候选列表瀑布流加载
- `app/hooks/useInfiniteScroll.ts` — 新增基于 IntersectionObserver 的无限滚动 Hook
- `app/routes/app.candidates.tsx` — 加载更多按钮替换为哨兵 div，滚动触底自动触发游标分页

## Bug 修复

### AI 模型超时幽灵日志（`openai.provider.ts`）
- **根因**: `Promise.race` 超时胜出后，IIFE（Async IIFE）因 `AbortController` 未能取消已抵近完成的 HTTP 请求，仍在后台继续执行并打出 `"AI 模型调用成功"`，造成日志与真实流程矛盾。
- **修复**: 引入 `raceSettled` 标志，超时分支先设标记再 reject；IIFE 所有关键节点（fetch catch、HTTP 错误、JSON 解析、空内容、成功返回前）检查该标记，若 race 已定则静默返回，避免幽灵日志与未处理的 Promise rejection。
