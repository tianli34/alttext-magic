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
`prisma/schema.prisma` — 新增 `GenerationBatch` 模型及其 `GenerationBatchStatus` 枚举，更新 `AltDraft` 关联，执行迁移并生成类型。

### Task 6.2 — AI Gateway 服务：统一抽象层 + Fake Provider + 主/副模型切换
- `server/ai/ai.types.ts` — `GenerateAltRequest`、`GenerateAltResult`、`AIGenerationError`、`AIProvider` 接口
- `server/ai/providers/fake.provider.ts` — 确定性假文本，`trigger-fake-failure` / `trigger-fake-delay` 特殊 URL 支持
- `server/ai/providers/openai.provider.ts` — OpenAI 兼容 Provider，30s 超时，5xx 视为可重试失败
- `server/ai/providers/fallback.provider.ts` — 主失败自动切换副，双失败抛 `AIGenerationError`，记录 pino 结构化日志
- `server/ai/ai-gateway.ts` — `AIGatewayService` 单例门面，`AI_PROVIDER=fake` 走 Fake，否则走真实主/副链
- `server/config/env.ts` — 新增 `AI_PROVIDER`、`AI_PRIMARY_*`、`AI_FALLBACK_*` 环境变量 zod 校验
- `.env.example` — 添加 AI 相关模板（无真实 Key）
- `tests/ai-gateway.test.ts` — 16 项单元测试全部通过（确定性结果、超时 fallback、双失败抛错）