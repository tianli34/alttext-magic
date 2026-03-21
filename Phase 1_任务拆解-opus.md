

#### 一、AI 可完成性判断

- **结论：不可以全部交给 AI**
- **简要说明原因：**
  Phase 1 中约 **70% 的工作量**（项目脚手架、代码编写、Schema 设计、配置文件生成）可由 AI 独立完成。但以下环节必须由人工介入：
  1. **Shopify Partner Dashboard 操作**：创建 App、获取 API Key/Secret、创建开发店铺——涉及浏览器登录、账号权限、平台 GUI 操作。
  2. **Railway 平台操作**：注册/登录账号、创建 Project、Provision Postgres/Redis 插件、绑定域名——涉及真实云平台交互与付费决策。
  3. **环境变量注入**：将真实凭证（API Key、数据库连接串、加密密钥）写入 Railway 环境变量——涉及密钥安全与平台操作。
  4. **安装验收**：在真实 Shopify 开发店铺安装 App 并验证 OAuth 流程、Webhook 接收、iframe 加载——涉及浏览器真实环境操作。

---

#### 二、Phase 1 任务拆解

---

**1. 在 Shopify Partner Dashboard 创建 App**
- 类型：**人工任务**
- 目标：在 Shopify Partner Dashboard 中创建一个新的 App，获取 `SHOPIFY_API_KEY` 和 `SHOPIFY_API_SECRET`
- 产出物：App 的 API Key、API Secret；App URL 与重定向 URL 的初始配置
- 依赖关系：需要 Shopify Partner 账号（已注册并登录）
- 备注：涉及浏览器登录 Partner Dashboard、填写 App 信息、选择 App 类型（Custom/Public）。AI 无法操作真实浏览器 GUI。

---

**2. 创建 Shopify 开发店铺**
- 类型：**人工任务**
- 目标：创建一个用于开发与测试的 Shopify Development Store
- 产出物：可用的开发店铺域名（如 `alttext-dev.myshopify.com`）
- 依赖关系：Shopify Partner 账号
- 备注：需在 Partner Dashboard 手动创建，涉及账号操作与店铺配置选择。

---

**3. 注册 Railway 账号并创建 Project**
- 类型：**人工任务**
- 目标：在 Railway 平台创建项目，并 Provision PostgreSQL 和 Redis 两个内置插件
- 产出物：Railway Project 创建完成；获取 `DATABASE_URL`、`REDIS_URL`；确定 `web` 和 `worker` 两个 Service 的占位
- 依赖关系：Railway 账号（需注册/登录，可能涉及绑定 GitHub 或支付方式）
- 备注：涉及平台注册、付费计划选择、插件 Provision 等 GUI 操作。AI 无法完成。

---

**4. 生成环境变量清单与 `.env.example` 文件**
- 类型：**AI任务**
- 目标：根据 Phase 1 需要的所有配置项，生成完整的环境变量清单文档和 `.env.example` 模板文件
- 产出物：`.env.example` 文件，包含所有变量名、说明注释、示例值（如 `SHOPIFY_API_KEY=`、`SHOPIFY_API_SECRET=`、`DATABASE_URL=`、`REDIS_URL=`、`ENCRYPTION_KEY=`、`NODE_ENV=` 等）
- 依赖关系：无
- 备注：AI 生成模板，真实值由人工在后续任务中填入。

---

**5. 使用 Shopify CLI 初始化项目脚手架**
- 类型：**AI任务**
- 目标：基于 `@shopify/shopify-app-react-router` 模板生成完整的项目目录结构，包含 React Router + TypeScript 基础配置
- 产出物：完整的项目目录结构；`package.json`（含所有依赖：`@shopify/shopify-app-react-router`、`@shopify/polaris-types`、`@shopify/app-bridge-react`、`prisma`、`bullmq`、`ioredis`、`pino` 等）；`tsconfig.json`；`.gitignore`
- 依赖关系：任务 4 完成（`.env.example` 可用）
- 备注：AI 输出完整的初始化命令序列和/或直接生成全部文件内容。如使用 `shopify app init` 命令，AI 可给出精确的交互选项指引。

---

**6. 设计并编写 Prisma Schema（Phase 1 三表）**
- 类型：**AI任务**
- 目标：编写 `schema.prisma`，定义 `shops`、`sessions`、`webhook_event` 三张表的完整字段、索引与关系
- 产出物：`prisma/schema.prisma` 文件，包含：
  - `shops` 表：`id`, `shop_domain`(unique), `access_token_encrypted`, `installed_at`, `uninstalled_at`, `current_plan`(default FREE), `scan_scope_flags`, `created_at`, `updated_at`
  - `sessions` 表：兼容 `@shopify/shopify-app-session-storage-prisma` 所需字段
  - `webhook_event` 表：`id`, `shop_domain`, `topic`, `webhook_id`(unique, 幂等键), `payload`(JSON), `status`(enum: RECEIVED/PROCESSING/DONE/FAILED), `received_at`, `processed_at`
- 依赖关系：任务 5 完成（项目结构已存在）
- 备注：AI 需确保 `sessions` 表结构与 Shopify 官方 Prisma session storage adapter 兼容。

---

**7. 编写 Prisma 迁移脚本与数据库初始化配置**
- 类型：**AI任务**
- 目标：生成 Prisma 迁移命令和初始化脚本，确保在 Railway PostgreSQL 上可执行
- 产出物：迁移命令文档（`npx prisma migrate dev --name init`）；`prisma/seed.ts`（如需种子数据）；`package.json` 中增加 `prisma:migrate` 和 `prisma:generate` 脚本
- 依赖关系：任务 6 完成
- 备注：无

---

**8. 实现 Token 加密/解密工具模块**
- 类型：**AI任务**
- 目标：编写 AES-256-GCM 加密/解密工具函数，用于 Offline Access Token 的安全存储与读取
- 产出物：`app/utils/encryption.server.ts`，导出 `encrypt(plaintext: string): string` 和 `decrypt(ciphertext: string): string`；从 `ENCRYPTION_KEY` 环境变量读取密钥；包含单元测试文件 `app/utils/encryption.server.test.ts`
- 依赖关系：任务 5 完成（项目结构存在）
- 备注：AI 需确保 IV 随机生成、AuthTag 附带、输出格式为 `iv:authTag:ciphertext` 的 Base64 编码。

---

**9. 实现 Shopify OAuth 安装流程与 Session 持久化**
- 类型：**AI任务**
- 目标：配置 `@shopify/shopify-app-react-router` 的 OAuth 流程，完成安装回调中的 Offline Access Token 获取、加密存储与 Session 持久化
- 产出物：
  - `app/shopify.server.ts`：Shopify App 实例配置（apiKey、apiSecretKey、scopes、hostName、sessionStorage 指向 Prisma adapter）
  - 安装回调 hook（`afterAuth`）：将 `shop_domain`、`access_token_encrypted`、`installed_at` 写入 `shops` 表（upsert 逻辑，支持重装场景清除 `uninstalled_at`）
  - Session storage 配置使用 `@shopify/shopify-app-session-storage-prisma`
- 依赖关系：任务 6（Schema 完成）、任务 8（加密模块完成）
- 备注：AI 编写全部代码。OAuth 的实际触发验证在后续人工任务中进行。

---

**10. 实现 Webhook 注册配置**
- 类型：**AI任务**
- 目标：在 Shopify App 配置中声明需要注册的 Webhook topics，确保安装时自动注册
- 产出物：在 `app/shopify.server.ts` 或 `shopify.app.toml` 中配置 Webhook 订阅列表：`APP_UNINSTALLED`、`CUSTOMERS_DATA_REQUEST`、`CUSTOMERS_REDACT`、`SHOP_REDACT`、`BULK_OPERATIONS_FINISH`、`PRODUCTS_CREATE`、`PRODUCTS_UPDATE`、`PRODUCTS_DELETE`、`COLLECTIONS_CREATE`、`COLLECTIONS_UPDATE`、`COLLECTIONS_DELETE`
- 依赖关系：任务 9 完成
- 备注：使用 `shopify.app.toml` 声明式注册或 `shopifyApp()` 配置中的 `webhooks` 字段。

---

**11. 实现 Webhook Receiver 路由（HMAC 校验 + 幂等落库 + BullMQ 投递）**
- 类型：**AI任务**
- 目标：编写统一的 Webhook 接收端点，完成 HMAC 签名校验、`webhook_event` 幂等落库、快速返回 200、异步投递到 BullMQ
- 产出物：
  - `app/routes/webhooks.tsx`（或 `app/routes/api.webhooks.ts`）：React Router action handler
  - HMAC 校验逻辑（使用 `@shopify/shopify-api` 内置验证或手动实现）
  - 幂等检查：基于 `X-Shopify-Webhook-Id` 去重
  - `webhook_event` 表落库（status=RECEIVED）
  - BullMQ `webhookQueue.add()` 投递
  - 单元测试：模拟合法/非法签名、重复投递场景
- 依赖关系：任务 6（Schema）、任务 13（BullMQ 初始化）
- 备注：无

---

**12. 实现 `APP_UNINSTALLED` Handler**
- 类型：**AI任务**
- 目标：编写 `APP_UNINSTALLED` Webhook 的业务处理逻辑
- 产出物：
  - `app/jobs/handlers/appUninstalled.server.ts`：接收 `webhook_event` 记录，将对应 `shops` 表的 `uninstalled_at` 设为当前时间戳
  - 更新 `webhook_event.status` 为 DONE
  - 单元测试文件
- 依赖关系：任务 11 完成
- 备注：Phase 9 会补全完整的数据清理逻辑，此阶段仅标记 `uninstalled_at`。

---

**13. 实现 GDPR Webhook Handler（占位）**
- 类型：**AI任务**
- 目标：为三个 GDPR Webhook（`CUSTOMERS_DATA_REQUEST`、`CUSTOMERS_REDACT`、`SHOP_REDACT`）编写占位处理器
- 产出物：
  - `app/jobs/handlers/gdpr.server.ts`：三个函数，均落库 `webhook_event`（status=DONE）后返回
  - 路由级别确保返回 200
- 依赖关系：任务 11 完成
- 备注：占位实现，Phase 9 补全真实逻辑。

---

**14. 初始化 BullMQ 连接与 Queue/Worker 配置**
- 类型：**AI任务**
- 目标：建立 BullMQ 基础设施，创建队列实例与 Worker 空循环
- 产出物：
  - `app/queue/connection.server.ts`：IORedis 连接实例，从 `REDIS_URL` 环境变量读取
  - `app/queue/queues.server.ts`：定义 `webhookQueue` 队列
  - `worker/index.ts`：BullMQ Worker 入口，监听 `webhookQueue`，根据 topic 分发到对应 handler（`APP_UNINSTALLED` / GDPR），未识别 topic 日志警告并标记 DONE
  - `worker/tsconfig.json`（如 worker 独立编译）
- 依赖关系：任务 5（项目结构）
- 备注：此阶段 worker 仅处理 Webhook 相关 job，其余 queue 在后续阶段添加。

---

**15. 实现结构化日志模块**
- 类型：**AI任务**
- 目标：配置基于 `pino` 的结构化日志系统，统一 web 和 worker 的日志格式
- 产出物：
  - `app/utils/logger.server.ts`：pino 实例，支持 JSON 格式输出、log level 由 `LOG_LEVEL` 环境变量控制
  - 在 `shopify.server.ts`、Webhook receiver、Worker 入口等关键位置插入日志调用
- 依赖关系：任务 5 完成
- 备注：无

---

**16. 编写 App Bridge + Polaris 空壳页面与导航结构**
- 类型：**AI任务**
- 目标：创建 Embedded App 的前端页面骨架，包含 App Bridge 初始化和 Polaris 导航占位
- 产出物：
  - `app/root.tsx`：AppProvider（Polaris）+ App Bridge Provider 初始化
  - `app/routes/app.tsx`：嵌套布局，包含 `NavigationMenu`（Polaris `Frame` + `Navigation`），设置导航项：Dashboard / Review / History / Billing / Settings / Help
  - `app/routes/app._index.tsx`：Dashboard 占位页（显示 "Welcome to AltText Magic" 和空白 Polaris `Page`）
  - `app/routes/app.review.tsx`：Review 占位页
  - `app/routes/app.history.tsx`：History 占位页
  - `app/routes/app.billing.tsx`：Billing 占位页
  - `app/routes/app.settings.tsx`：Settings 占位页
  - `app/routes/app.help.tsx`：Help 占位页
- 依赖关系：任务 5（项目结构）、任务 9（shopify.server.ts 存在）
- 备注：所有页面此阶段为占位 UI，后续阶段逐步填充。

---

**17. 编写 Railway 部署配置文件**
- 类型：**AI任务**
- 目标：生成 Railway 部署所需的全部配置文件，使 `web` 和 `worker` 可分别部署
- 产出物：
  - `railway.toml` 或 `railway.json`：定义 `web` service（启动命令 `npm run start`）和 `worker` service（启动命令 `npm run worker`）
  - `Procfile`（如 Railway 需要）
  - `package.json` 中添加 `start`（React Router production server）、`worker`（运行 `worker/index.ts` 编译后入口）、`build`（含 Prisma generate + React Router build + Worker tsc build）、`postinstall`（Prisma generate）等脚本
  - `Dockerfile`（可选，若 Railway 使用 Nixpacks 则提供 `nixpacks.toml`）
  - 部署文档：说明如何在 Railway Dashboard 中创建两个 Service 并分别绑定到同一个 repo 的不同启动命令
- 依赖关系：任务 5、14 完成
- 备注：AI 生成配置文件和文档，实际在 Railway 平台操作由人工完成。

---

**18. 生成 AES-256-GCM 加密密钥**
- 类型：**人工任务**
- 目标：生成一个安全的 32 字节随机加密密钥，用于 Access Token 加密
- 产出物：一个 Base64 或 Hex 编码的 256-bit 随机密钥字符串
- 依赖关系：无
- 备注：AI 可提供生成命令（如 `openssl rand -hex 32`），但密钥的实际生成与安全保管必须由人工完成，不可在聊天记录或代码中暴露。

---

**19. 在 Railway 平台配置 Service 与环境变量**
- 类型：**人工任务**
- 目标：在 Railway Dashboard 中创建 `web` 和 `worker` 两个 Service，配置 GitHub 仓库关联、环境变量注入
- 产出物：Railway 上 `web` / `worker` / `postgres` / `redis` 四个 Service 配置完成；所有环境变量（`SHOPIFY_API_KEY`、`SHOPIFY_API_SECRET`、`DATABASE_URL`、`REDIS_URL`、`ENCRYPTION_KEY`、`SCOPES`、`HOST` 等）已注入
- 依赖关系：任务 1（API Key/Secret）、任务 3（Railway Project/插件已创建）、任务 17（配置文件就绪）、任务 18（加密密钥已生成）
- 备注：涉及平台 GUI 操作、凭证粘贴、域名绑定。AI 无法完成。

---

**20. 将 Shopify App URL 和重定向 URL 更新为 Railway 域名**
- 类型：**人工任务**
- 目标：在 Shopify Partner Dashboard 中将 App URL 和 OAuth Redirect URL 更新为 Railway 部署后的实际域名
- 产出物：Partner Dashboard 中 App 配置的 URL 已更新，与 Railway `web` service 域名一致
- 依赖关系：任务 19 完成（Railway Service 已部署，域名可用）
- 备注：涉及 Partner Dashboard GUI 操作。

---

**21. 首次部署到 Railway 并验证服务健康**
- 类型：**人工任务**
- 目标：触发首次部署，确认 `web` / `worker` / `postgres` / `redis` 四个 Service 全部 healthy
- 产出物：Railway Dashboard 显示所有 Service 状态为 Active/Healthy；数据库迁移已执行成功；`web` 服务可通过公网域名访问
- 依赖关系：任务 19、20 完成
- 备注：需人工在 Railway 触发部署、查看日志、排查首次部署问题。

---

**22. 在开发店铺安装 App 并验证 OAuth 流程**
- 类型：**人工任务**
- 目标：在 Shopify 开发店铺中安装 App，走完 OAuth 授权流程，验证 Embedded iframe 加载
- 产出物：
  - App 安装成功，Shopify Admin 内可看到 Embedded iframe 中的 Polaris 空壳页面
  - `shops` 表中写入正确记录：`shop_domain`、`access_token_encrypted`（可解密还原）、`installed_at`、`current_plan=FREE`
- 依赖关系：任务 2（开发店铺存在）、任务 21（服务已部署）
- 备注：涉及浏览器操作、OAuth 授权确认。

---

**23. 验证 Webhook 接收与处理**
- 类型：**人工任务**
- 目标：在开发店铺卸载 App，验证 `APP_UNINSTALLED` Webhook 被正确接收并处理；手动触发 GDPR Webhook 测试
- 产出物：
  - `webhook_event` 表中有 `APP_UNINSTALLED` 记录，status=DONE
  - `shops` 表中对应记录的 `uninstalled_at` 已被设置
  - GDPR Webhook 端点返回 200（可通过 Shopify Partner Dashboard 的 Webhook 测试功能或 curl 验证）
  - Railway 日志中可见结构化日志输出
- 依赖关系：任务 22 完成（App 已安装）
- 备注：需人工在 Shopify Admin 执行卸载操作，并在 Railway 日志和数据库中检查结果。

---

**24. 编写 Phase 1 验收检查清单文档**
- 类型：**AI任务**
- 目标：基于 Phase 1 的 6 条验收标准，生成可执行的验收检查清单和操作步骤文档
- 产出物：`docs/phase1-acceptance-checklist.md`，包含每条验收标准的具体操作步骤、预期结果、实际结果填写栏
- 依赖关系：无（可与其他任务并行）
- 备注：无

---

**25. 最终验收确认**
- 类型：**人工任务**
- 目标：按照验收检查清单逐项确认所有 6 条验收标准全部通过
- 产出物：Phase 1 验收报告，标注每条验收标准的通过状态
- 依赖关系：任务 22、23 完成
- 备注：最终验收需人工在真实环境中执行并确认。

---

#### 三、AI 执行建议

**最适合交给 AI 连续完成的任务链：**

任务 4 → 5 → 6 → 7 → 8 → 15 → 14 → 9 → 10 → 11 → 12 → 13 → 16 → 17 → 24

这 15 个任务构成了 Phase 1 的**全部代码与配置产出**，彼此之间有清晰的依赖链，可在一个连续的 AI 会话中依次完成。总代码工作量约占 Phase 1 工时的 **70%**（约 5.5 人天）。建议在一次 session 中按顺序要求 AI 逐个产出，每个任务产出后做简要 review 即可继续。

**应尽早完成的人工任务（关键阻塞项）：**

| 优先级 | 任务 | 阻塞影响 |
|:---:|:---|:---|
| 🔴 P0 | 任务 1 — 创建 Shopify App | 阻塞任务 9（OAuth 配置需要 API Key/Secret）、任务 19（环境变量）|
| 🔴 P0 | 任务 2 — 创建开发店铺 | 阻塞任务 22（安装验证）|
| 🔴 P0 | 任务 3 — 创建 Railway Project | 阻塞任务 19（环境变量配置）、任务 21（部署）|
| 🟡 P1 | 任务 18 — 生成加密密钥 | 阻塞任务 19（环境变量中需要 `ENCRYPTION_KEY`）|

**建议执行顺序：**
1. **先完成人工任务 1、2、3、18**（约 1-2 小时即可全部搞定），拿到所有外部凭证。
2. **随即启动 AI 任务链**（4→5→…→24），AI 可在无阻塞的情况下连续产出全部代码。
3. 代码就绪后，执行人工任务 19→20→21→22→23→25 完成部署与验收。

这样可以最大化 AI 的连续产出效率，人工仅在**起点**（拿凭证）和**终点**（部署验收）介入。























