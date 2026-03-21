

你是一位精通 Shopify App 开发、Node.js/TypeScript 全栈工程以及 OpenAI Codex 的高级工程师。我正在开发一款名为 **AltText Magic** 的 Shopify 嵌入式 App，需要你帮我规划并执行如何使用 **Codex** 来完成**Phase 1**的开发工作。

---

# AltText Magic — 分阶段开发计划 v1.0

---

## 1. 项目概览

**AltText Magic** 是一款面向 Shopify 中小商家的嵌入式 App（Embedded App），通过 AI 在"可控、可审阅"的前提下，批量为店铺四类图片资源（产品媒体 / 文件库 / 集合封面 / 文章封面）补齐缺失的 Alt Text。MVP 需完整跑通 **"扫描 → 生成 → 审阅 → 写回"** 安全闭环，并支持装饰性图片标记、共享文件影响范围提示、Freemium 五档计费与超额包、付费计划专属增量扫描等能力。

**技术栈**：Node.js + TypeScript / React Router（Web）/ Prisma + PostgreSQL / Redis + BullMQ / Shopify App Bridge + Polaris / AI Gateway（主模型 + 降级模型）。部署目标为 Railway（web + worker + postgres + redis）。MVP 核心交付范围覆盖架构文档 §1.1 所列全部 21 项必须做项，以及 §1.2 非功能约束。

---

## 2. 阶段总览

| 阶段 | 名称                         | 核心产出                                               |
|:----:|:-----------------------------|:-------------------------------------------------------|
|  1   | 基础设施与 Shopify App 骨架  | 可部署的空壳 Embedded App                              |
|  2   | 数据模型与核心服务层         | 完整 Schema 迁移 + Scope/Mutex/Notice 服务             |
|  3   | 全量扫描管线                 | Bulk 提交 → 流式解析 → Staging → Derive → 原子发布 |
|  4   | 仪表盘、候选列表与装饰性标记 | Dashboard 分组统计 + 候选展示投影 + 装饰性标记         |
|  5   | 计费与配额系统               | 五档订阅 + 欢迎额度 + Free 月配额 + 超额包 + 额度预留  |
|  6   | AI 生成管线                  | 额度预检 → 线上真值复核 → AI 调用 → 草稿 → 扣费    |
|  7   | 审阅编辑与写回               | 可编辑审阅列表 + 按 alt_plane 路由写回 + 审计          |
|  8   | 增量扫描与 Webhook 驱动      | Debounce + 四重 Gate + 图片指纹 + 原子 Patch           |
|  9   | 设置、历史记录与运维收尾     | Settings 页 / History 页 / 清理任务 / GDPR / 可观测性  |
|  10  | 集成测试与上线准备           | 端到端回归 + App Store 提审材料 + FAQ                  |


---

## 3. Phase 1 详细计划

---

### Phase 1：基础设施与 Shopify App 骨架

**阶段目标**
搭建可部署的 Shopify Embedded App 空壳，完成 OAuth 安装流程、Session 持久化、基础 Webhook 注册与接收，建立 Railway 部署管线。此阶段结束后，App 可在 Shopify Admin 内以 iframe 形式加载并展示空白 Polaris 页面。

**功能范围**

| # | 功能项 | 对应架构 |
|---|--------|----------|
| 1.1 | 项目脚手架：React Router + TypeScript + Prisma + BullMQ | §3.1 App Server / §3.2 Railway |
| 1.2 | Railway 部署拓扑：`web` / `worker` / `postgres` / `redis` 四个 Service | §3.2 |
| 1.3 | Shopify OAuth 安装流程 + Offline Access Token 加密存储 | §4.1 |
| 1.4 | Session 持久化（Prisma Session Storage） | §4.1 |
| 1.5 | `shops` 表初始化（安装时写入 `shop_domain`, `installed_at`, `current_plan=FREE`, 默认 `scan_scope_flags`） | §5.1 |
| 1.6 | Webhook 注册：`APP_UNINSTALLED` / GDPR 三类 / `BULK_OPERATIONS_FINISH` / `products/*` / `collections/*` | §4.1 步骤 4 |
| 1.7 | Webhook Receiver：HMAC 校验 + `webhook_event` 幂等落库 + 快速 200 + BullMQ 投递 | §4.3.9 |
| 1.8 | `APP_UNINSTALLED` handler（标记 `uninstalled_at`，后续 Phase 9 补全删除） | §4.10 |
| 1.9 | GDPR Webhook handler（占位实现，返回 200） | §4.10 |
| 1.10 | App Bridge + Polaris 空壳页面（含导航结构占位：Dashboard / Review / History / Billing / Settings / Help） | §3.1 Web |
| 1.11 | 环境变量管理 + 基础结构化日志 | §10 |

**依赖关系**
- 外部：Shopify Partner Dashboard App 创建、Railway 账号、域名
- 内部：无前置阶段依赖

**技术方案**
- 使用 Shopify CLI 或 `@shopify/shopify-app-react-router` 模板初始化项目
- Prisma schema 此阶段只建 `shops` / `sessions` / `webhook_event` 三张表
- Token 加密使用 AES-256-GCM，密钥由环境变量注入
- BullMQ 连接 Redis，此阶段只创建 queue 实例，不处理业务 job
- Railway：`web` service 运行 React Router；`worker` service 运行 BullMQ processor（空循环）；Postgres 与 Redis 使用 Railway 内置插件

**验收标准**
1. ✅ 在 Shopify 开发店铺成功安装 App，Admin 内可打开 Embedded iframe
2. ✅ `shops` 表写入正确，`access_token_encrypted` 可解密还原
3. ✅ 卸载 App 后，`APP_UNINSTALLED` Webhook 被接收并写入 `webhook_event`
4. ✅ GDPR Webhook 返回 200，不报错
5. ✅ Railway `web` / `worker` / `postgres` / `redis` 四个 Service 全部 healthy
6. ✅ 结构化日志可在 Railway Log 中查看


---



