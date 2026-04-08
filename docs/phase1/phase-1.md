# AltText Magic — Phase 1 AI编程上下文

## 项目简介
Shopify Admin Embedded App，自动生成图片 Alt Text。Phase 1：**搭建可部署空壳 Embedded App**，完成 OAuth、Session 持久化、Webhook 收发，建立 Railway 部署管线。

## 技术栈
Node.js + TypeScript / React Router + App Bridge + Polaris Web Components / Prisma + PostgreSQL / Redis + BullMQ  
脚手架：`@shopify/shopify-app-react-router` 模板  
部署：Railway（`web` / `worker` / `postgres` / `redis`）

## 功能清单

| # | 功能项 |
|---|--------|
| 1.1 | 项目脚手架：React Router + TypeScript + Prisma + BullMQ |
| 1.2 | Railway 部署：`web` / `worker`(BullMQ 空循环) / `postgres` / `redis` |
| 1.3 | OAuth + Offline Token **AES-256-GCM** 加密存储 |
| 1.4 | Session 持久化（Prisma Session Storage） |
| 1.5 | `shops` 表：安装时写入 domain/plan=FREE/scope_flags=15 |
| 1.6 | Webhook 注册：`APP_UNINSTALLED` / GDPR×3 / `BULK_OPERATIONS_FINISH` / `products/*` / `collections/*` |
| 1.7 | Webhook Receiver：HMAC 校验 → 幂等落库 → 200 → BullMQ 投递 |
| 1.8 | `APP_UNINSTALLED`：标记 `uninstalled_at`（删除留 Phase 9） |
| 1.9 | GDPR handler：占位返回 200 |
| 1.10 | Polaris 空壳页面：Dashboard / Review / History / Billing / Settings / Help |
| 1.11 | 环境变量管理 + 结构化日志 |

## Prisma Schema（3张表）

**shops**
```
id              String    PK (cuid)
shop_domain     String    unique, xxx.myshopify.com
access_token_encrypted  String  AES-256-GCM
installed_at    DateTime
uninstalled_at  DateTime?
current_plan    String    默认 "FREE"
scan_scope_flags Int      默认 15 (PRODUCT_MEDIA=1|FILES=2|COLLECTION=4|ARTICLE=8)
created_at/updated_at DateTime
```

**sessions** — 遵循 `@shopify/shopify-app-session-storage-prisma` 规范

**webhook_event**
```
id          String    PK (cuid)
shop_domain String
topic       String
webhook_id  String    unique (X-Shopify-Webhook-Id, 幂等键)
payload     Json
processed   Boolean   默认 false
created_at  DateTime
```

## Webhook 处理流程
```
POST /webhooks → HMAC校验 → webhook_id去重 → 写表 → 200 → BullMQ投递
Phase 1 仅处理 APP_UNINSTALLED（设 shops.uninstalled_at = now()）
```

## BullMQ
Phase 1 仅创建 queue + worker 框架，worker 独立 service 空循环保持 healthy。

## 前端
App Bridge + Polaris Web Components，`<NavMenu>` 导航，6个占位空页面。

## 环境变量
```
SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SCOPES / HOST
DATABASE_URL / REDIS_URL
TOKEN_ENCRYPTION_KEY    # 32字节 hex/base64
NODE_ENV
```

## 完成标准
- App 可成功安装并在 Shopify Admin 中打开 Embedded 页面
- OAuth、Session 持久化、shops 初始化可正常工作
- Webhook 可通过校验、幂等落库并处理 APP_UNINSTALLED
- GDPR Webhook 至少能安全返回 200
- Railway 上 web/worker/postgres/redis 服务均可正常运行

## 后续预告（Phase 1 不实现）
Phase 2 完整 Schema（26+ 表）+ Scope/Mutex/Notice；Phase 3 全量扫描。`shops` 已预留 `scan_scope_flags`、`current_plan` 避免改表。