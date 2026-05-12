# Completed

## 📦 基础设施与前期状态 (已闭环)
- **技术栈**：Shopify Embedded App (React/Polaris Web Components) + Node.js + Prisma (PostgreSQL) + BullMQ。
- **业务状态**：Phase 3 后台扫描与 Phase 4 数据看板/候选管理均已完成并闭环。
- **前置数据库依赖**：Phase 2 已就绪相关表结构（`credit_bucket` / `credit_reservation` / `credit_reservation_line` / `billing_subscription` / `billing_ledger`）。

# In Progress（本地开发）- Phase 5：计费与配额系统
## Task 5.2：计费计划与额度配置常量 ✅
billing.types.ts、server/config/plans.ts、plan-config.ts
## Task 5.3：Credit Bucket 发放与 Ledger 写入服务 ✅
`server/modules/billing/credit/grant-credit.server.ts` — 统一额度发放服务
## Task 5.4：新安装店铺默认额度初始化 ✅
`server/modules/billing/bootstrap-shop-billing.server.ts` — 店铺计费初始化服务
- 创建 `billing_subscription`（FREE, NONE, ACTIVE）
- 发放 WELCOME(50) + FREE_MONTHLY_INCLUDED(25)
- 接入 `shopify.server.ts` afterAuth hook
- 重构 `shop.service.ts` 移除旧的 credit bucket 逻辑
- 修复 `INSTALL_WELCOME.cycleKeyTag` 为 `WELCOME:INSTALL`
