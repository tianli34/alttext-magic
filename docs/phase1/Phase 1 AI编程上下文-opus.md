

# AltText Magic — Phase 1 AI编程上下文

## 项目简介
Shopify Admin Embedded App，为商家图片自动生成 Alt Text。Phase 1 目标：**搭建可部署的空壳 Embedded App**，完成 OAuth、Session 持久化、Webhook 基础收发，建立 Railway 部署管线。

## 技术栈
- **Runtime**: Node.js + TypeScript
- **Web**: React Router + Shopify App Bridge + Polaris Web Components
- **ORM**: Prisma + PostgreSQL
- **Queue**: Redis + BullMQ
- **部署**: Railway (`web` / `worker` / `postgres` / `redis` 四个 Service)
- **脚手架**: 基于 `@shopify/shopify-app-react-router` 模板初始化

## Phase 1 功能清单

| # | 功能项 |
|---|--------|
| 1.1 | 项目脚手架：React Router + TypeScript + Prisma + BullMQ |
| 1.2 | Railway 部署拓扑：`web`(React Router) / `worker`(BullMQ processor 空循环) / `postgres` / `redis` |
| 1.3 | Shopify OAuth 安装流程 + Offline Access Token **AES-256-GCM** 加密存储（密钥环境变量注入） |
| 1.4 | Session 持久化（Prisma Session Storage） |
| 1.5 | `shops` 表初始化：安装时写入 `shop_domain`, `installed_at`, `current_plan=FREE`, 默认 `scan_scope_flags` |
| 1.6 | Webhook 注册：`APP_UNINSTALLED` / GDPR×3 / `BULK_OPERATIONS_FINISH` / `products/create|update` / `collections/create|update` |
| 1.7 | Webhook Receiver：HMAC 校验 → `webhook_event` 幂等落库 → 快速 200 → BullMQ 投递 |
| 1.8 | `APP_UNINSTALLED` handler：标记 `shops.uninstalled_at`（实际删除留到 Phase 9） |
| 1.9 | GDPR Webhook handler：占位实现，返回 200 |
| 1.10 | App Bridge + Polaris Web Components 空壳页面，导航占位：Dashboard / Review / History / Billing / Settings / Help |
| 1.11 | 环境变量管理 + 基础结构化日志 |

## Phase 1 Prisma Schema（仅3张表）

### shops
| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid/uuid) | PK |
| shop_domain | String | unique, `xxx.myshopify.com` |
| access_token_encrypted | String | AES-256-GCM 加密后的 Offline Token |
| installed_at | DateTime | 安装时间 |
| uninstalled_at | DateTime? | 卸载时标记 |
| current_plan | String | 默认 `FREE` |
| scan_scope_flags | Int | 位标志，默认全选(产品媒体/文件/集合/文章) |
| created_at / updated_at | DateTime | 时间戳 |

### sessions
Shopify Session 持久化所需字段，遵循 `@shopify/shopify-app-session-storage-prisma` 规范。

### webhook_event
| 字段 | 类型 | 说明 |
|------|------|------|
| id | String (cuid/uuid) | PK |
| shop_domain | String | 来源店铺 |
| topic | String | Webhook topic |
| webhook_id | String | unique, Shopify `X-Shopify-Webhook-Id`，用于幂等 |
| payload | Json | 原始 payload |
| processed | Boolean | 默认 false |
| created_at | DateTime | |

## scope_flags 位定义（后续阶段会用，此阶段只需存默认值）
```
PRODUCT_MEDIA = 1
FILES = 2
COLLECTION_IMAGE = 4
ARTICLE_IMAGE = 8
默认全选 = 15
```

## Webhook 处理流程
```
Shopify → POST /webhooks
  1. HMAC-SHA256 校验（用 SHOPIFY_API_SECRET）
  2. 查 webhook_event 是否已存在该 webhook_id → 幂等去重
  3. 写入 webhook_event 表
  4. 立即返回 200
  5. 按 topic 投递对应 BullMQ queue（Phase 1 只处理 APP_UNINSTALLED）
```

## APP_UNINSTALLED 处理
- 设置 `shops.uninstalled_at = now()`
- **不做**数据删除（Phase 9 实现）

## BullMQ 配置
- Phase 1 只创建 queue 实例和基础 worker 框架
- Worker 进程作为独立 `worker` service 部署
- 此阶段无业务 job 需要处理，worker 做空循环保持 healthy

## 前端页面结构（空壳）
```
App Shell (App Bridge Provider + Polaris Web Components)
├── Dashboard    (空页面, 占位)
├── Review       (空页面, 占位)
├── History      (空页面, 占位)
├── Billing      (空页面, 占位)
├── Settings     (空页面, 占位)
└── Help         (空页面, 占位)
```
使用 <s-app-nav> 或 React <NavMenu> 构建导航。

## 环境变量
```
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SCOPES                    # Shopify OAuth scopes
HOST                      # App URL
DATABASE_URL              # PostgreSQL
REDIS_URL                 # Redis
TOKEN_ENCRYPTION_KEY      # AES-256-GCM 密钥 (32字节 hex/base64)
NODE_ENV
```

## 验收标准
1. ✅ 开发店铺成功安装 App，Admin 内可打开 Embedded iframe 显示 Polaris 页面
2. ✅ `shops` 表写入正确，`access_token_encrypted` 可解密还原
3. ✅ 卸载 App → `APP_UNINSTALLED` Webhook 写入 `webhook_event`，`shops.uninstalled_at` 被标记
4. ✅ GDPR Webhook 返回 200 不报错
5. ✅ Railway 四个 Service 全部 healthy
6. ✅ 结构化日志可在 Railway Log 中查看

## 后续阶段预告（仅供理解设计意图，Phase 1 不实现）
Phase 2 将建完整 Schema（26+ 张表）并实现 Scope/Mutex/Notice 服务；Phase 3 实现全量扫描管线。`shops` 表设计需预留 `scan_scope_flags`、`current_plan` 等字段以便后续阶段无需改表。


