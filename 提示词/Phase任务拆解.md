




【任务】
将Phase 2拆解为适合Codex执行的任务


【背景】
# AltText Magic — 分阶段开发计划（省略版）

---

## 1. 项目概览

**AltText Magic** 是一款面向 Shopify 中小商家的嵌入式 App（Embedded App），通过 AI 在“可控、可审阅”的前提下，批量为店铺四类图片资源（产品媒体 / 文件库 / 集合封面 / 文章封面）补齐缺失的 Alt Text。MVP 需完整跑通 **“扫描 → 生成 → 审阅 → 写回”** 安全闭环，并支持装饰性图片标记、共享文件影响范围提示、Freemium 五档计费与超额包、付费计划专属增量扫描等能力。

**技术栈**：Node.js + TypeScript / React Router（Web）/ Prisma + PostgreSQL / Redis + BullMQ / Shopify App Bridge + Polaris / AI Gateway（主模型 + 降级模型）。

**开发与部署原则**
1. **本地开发阶段**：使用 `docker-compose` 在本地运行 **PostgreSQL** 与 **Redis** 容器。
2. **应用进程运行方式**：**Web** 与 **Worker** 进程均在宿主机独立运行，不放入 Docker 容器中，便于热更新、断点调试、日志观察与快速迭代。
3. **Shopify 联调方式**：通过 Shopify CLI 提供的本地开发能力与公网 tunnel（如 CLI 自带 tunnel / Cloudflare / ngrok）完成 OAuth、Webhook、Embedded iframe 调试。
4. **环境一致性原则**：本地阶段就按未来线上拆分方式组织进程边界，即 `web` / `worker` / `postgres` / `redis` 四个逻辑组件保持一致。
5. **上线策略**：待核心业务闭环在本地环境完整跑通后，再统一部署到 Railway，映射为 `web + worker + postgres + redis` 四类服务。
6. **交付范围**：MVP 核心交付范围覆盖架构文档 §1.1 所列全部 21 项必须做项，以及 §1.2 非功能约束。

---

## 2. 阶段总览

| 阶段 | 名称 | 核心产出 |
|:----:|:-----|:---------|
| 1 | 基础设施与 Shopify App 骨架 | **本地可运行**的空壳 Embedded App |
| 2 | 数据模型与核心服务层 | 完整 Schema 迁移 + Scope/Mutex/Notice 服务 |
| 3 | 全量扫描管线 | Bulk 提交 → 流式解析 → Staging → Derive → 原子发布 |
……

---


……

## Phase 2：数据模型与核心服务层

**阶段目标**  
完成 MVP 完整数据模型的 Prisma Schema 定义与迁移，并交付三个基础服务模块：**扫描说明确认（Notice）**、**Scope 管理**、**Shop 级互斥锁**。此阶段结束后，所有表结构就绪，`GET /api/bootstrap` 可返回正确的初始状态。

**功能范围**

| # | 功能项 | 对应架构 |
|---|--------|----------|
| 2.1 | 完整 Prisma Schema 定义（§5 全部 26 张表）并执行迁移 | §5.1–5.26 |
| 2.2 | 唯一约束与索引：`alt_target(shop_id, alt_plane, write_target_id, locale)`、`alt_candidate(alt_target_id)`、`candidate_group_projection(shop_id, group_type, alt_candidate_id)`、`credit_bucket(shop_id, bucket_type, cycle_key)` 等 | §5 各表约束 |
| 2.3 | `scan_notice_ack` 服务：创建确认记录、版本检查 | §4.2.1 |
| 2.4 | `shops.scan_scope_flags` 管理服务：读取 / 更新 / 计算 `effective_read_scope_flags` | §4.2.2 |
| 2.5 | `POST /api/settings/scope` API | §4.2.3 |
| 2.6 | `shop_operation_lock` 服务：获取锁 / 释放锁 / heartbeat / 超时检测 | §4.2.4–4.2.5 |
| 2.7 | `GET /api/bootstrap` API（返回计划、额度占位、notice 状态、scope 状态、最近扫描状态） | §6.1 |
| 2.8 | 安装时初始化逻辑完善：创建安装欢迎额度 bucket（50 张）+ 当月 Free 月配额 bucket（25 张） | §4.1 步骤 3 |

**依赖关系**
- 前置：Phase 1（App 骨架、`shops` 表基础字段、Prisma 连接）

**技术方案**
- 一次性迁移全部表结构，避免后续频繁 migration；字段级注释标注对应架构文档节号。
- 本地开发阶段使用本地 Docker PostgreSQL 执行迁移：
  - 开发期：`npx prisma migrate dev`
  - 预发布验证：在空库上执行 `npx prisma migrate deploy`
- `scan_scope_flags` 与 `last_published_scope_flags` 使用 Prisma `Json` 类型，值为 `string[]`（如 `["PRODUCT_MEDIA","FILES","COLLECTION_IMAGE","ARTICLE_IMAGE"]`）。
- `effective_read_scope_flags` 为计算属性，不持久化，在服务层 / API 层实时求交集。
- `shop_operation_lock` 使用 `unique(shop_id)` + 事务内 `SELECT ... FOR UPDATE` 实现悲观锁；`expires_at` 默认 30 分钟，worker heartbeat 每 5 分钟刷新。
- `credit_bucket` 初始化在 OAuth 安装回调中同步执行，事务内完成 shops 创建 + bucket 创建。
- 为保证未来 Railway 兼容：
  - 本地生成的 migration 文件必须可在 CI / Railway 上通过 `prisma migrate deploy` 重放
  - 不依赖本地手工改库

**验收标准**
1. ✅ 在本地 Docker PostgreSQL 上执行 `npx prisma migrate dev` 无错误，26 张表全部创建成功；同一批 migration 在空库上执行 `npx prisma migrate deploy` 也无错误
2. ✅ 安装新店铺后，`credit_bucket` 中存在 `WELCOME(50)` + `FREE_MONTHLY_INCLUDED(25)` 两条记录
3. ✅ `GET /api/bootstrap` 对全新店铺返回 `needsNoticeAck: true`，scope 为默认四类
4. ✅ `POST /api/settings/scope` 只更新 `scan_scope_flags`，不修改 `last_published_scope_flags`
5. ✅ 互斥锁测试：acquire → 再次 acquire 返回 conflict → release → 可再次 acquire
6. ✅ 锁超时 30 分钟后，cleanup 可回收

……

---
