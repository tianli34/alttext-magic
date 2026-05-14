# Completed（本地开发）

## 📦 基础设施与前期状态 (已闭环)
- **技术栈**：Shopify Embedded App (React/Polaris Web Components) + Node.js + Prisma (PostgreSQL) + BullMQ。
- **业务状态**：Phase 3 后台扫描与 Phase 4 数据看板/候选管理均已完成并闭环。
- **前置数据库依赖**：Phase 2 已就绪相关表结构（`credit_bucket` / `credit_reservation` / `credit_reservation_line` / `billing_subscription` / `billing_ledger`）。

## Phase 5：计费与配额系统
### Task 5.2：计费计划与额度配置常量
billing.types.ts、server/config/plans.ts、plan-config.ts
### Task 5.3：Credit Bucket 发放与 Ledger 写入服务
`server/modules/billing/credit/grant-credit.server.ts` — 统一额度发放服务
### Task 5.4：新安装店铺默认额度初始化
`server/modules/billing/bootstrap-shop-billing.server.ts` — 店铺计费初始化服务
### Task 5.5：Shopify Billing API Adapter
`billing-adapter.types.ts`、`billing-adapter.server.ts`、`billing-adapter.fake.ts`、`billing-adapter.ts`
### Task 5.6：POST /api/billing/change-plan
`app/routes/api.billing.change-plan.tsx`、`server/modules/billing/plan-change.service.ts`
### Task 5.7：订阅回调与 Webhook 同步入口
`server/modules/billing/subscription.service.ts`（统一订阅同步服务）、`app/routes/api.billing.callback.tsx`（GET /api/billing/callback）、`app/routes/webhooks.app.subscriptions_update.tsx`（APP_SUBSCRIPTIONS_UPDATE webhook handler）、`server/queues/billing-sync.queue.ts`、`worker/processors/billing-sync.processor.ts`
### Task 5.8：订阅升级 / 降级业务处理服务
`server/modules/billing/apply-subscription-change.server.ts` — 订阅变更处理服务（included bucket 发放、首次付费欢迎额度、增量扫描开关、Free 降级补发）
### Task 5.9：Free 月配额自动发放 Job
`server/modules/billing/credit/free-monthly-grant.service.ts` — 核心批量发放服务、`server/queues/quota-grant.queue.ts` — BullMQ 队列定义、`worker/processors/quota-grant.processor.ts` — Job processor、`worker/schedulers/free-monthly-grant.scheduler.ts`
### Task 5.10：超额包购买 API 与成功发放逻辑
`server/modules/billing/overage-pack.service.ts` — initiateOveragePackPurchase + fulfillOveragePackPurchase、`app/routes/api.billing.purchase-pack.tsx` — POST /api/billing/purchase-pack、`app/routes/api.billing.purchase-callback.tsx` — GET /api/billing/purchase-callback
### Task 5.11：额度余额与消费顺序计算服务
`server/modules/billing/credit/consumption-order.ts` — 消费优先级常量与排序工具、`server/modules/billing/credit/credit-balance.server.ts` — getCreditBalance + getSpendableBuckets + planCreditAllocation
### Task 5.12：Credit Reservation 服务
`app/services/credits/credit-reservation.server.ts` — batch 级预留、consume、release
### Task 5.13：生成前额度预检 API
`app/routes/api.generation.preflight.tsx` — POST /api/generation/preflight
### Task 5.14：GET /api/billing/summary
`app/routes/api.billing.summary.tsx` — GET /api/billing/summary
### Task 5.15：Reservation Reaper Job
`server/queues/reservation-reaper.queue.ts` — BullMQ 队列定义、`worker/processors/reservation-reaper.processor.ts` — 过期 reservation 清理 processor、`worker/schedulers/reservation-reaper.scheduler.ts`
### Task 5.16：Billing 前端页面
types.ts useBillingSummary.ts useChangePlan.ts usePurchasePack.ts useQuota.ts BillingIntervalToggle.tsx PlanCard.tsx QuotaBreakdown.tsx OveragePackCard.tsx app.billing.tsx
### Task 5.17：Dashboard 首页配额摘要集成
`app/components/dashboard/QuotaSummary.tsx` — 接入 useBillingSummary 展示真实计费数据，含 loading/error 降级处理
### Task 5.18：Billing Sync Job（定时兜底同步）
`worker/jobs/billing-sync.job.ts` — 批量同步所有店铺 Shopify 订阅状态 + applySubscriptionChange 额度发放、`worker/processors/billing-sync.processor.ts` — 支持单 shop / 批量模式、`worker/schedulers/billing-sync.scheduler.ts` — 每 6 小时 repeatable job、`server/queues/billing-sync.queue.ts` — 批量模式支持 + getter 导出

## Phase 6：AI 生成管线
### Task 6.1 — 数据库 Schema 扩展：`generation_batch` + `alt_draft`
`prisma/schema.prisma` — 新增 `GenerationBatch` 模型及其 `GenerationBatchStatus` 枚举，更新 `AltDraft` 关联，执行迁移并生成类型。
