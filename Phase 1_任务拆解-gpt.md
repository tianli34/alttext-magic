#### 一、AI 可完成性判断
- 结论：不可以全部交给 AI
- 简要说明原因：AI 可以独立完成项目结构设计、Prisma schema、OAuth/Session/Webhook/BullMQ/Polaris 代码、部署配置、测试与联调文档；但 Shopify Partner App 创建、开发店铺安装、API 凭证生成与安全保存、Railway 资源创建与密钥注入、Shopify/Railway 后台真实操作、Webhook 实际触发验证、最终验收都依赖账号权限、平台操作和真实环境访问，必须人工完成。当前信息已足够拆解任务，但仍缺少几项关键输入需要人工确认：OAuth scopes、`products/*` 与 `collections/*` 需展开为哪些具体 webhook topic、默认 `scan_scope_flags` 结构、最终 App URL / Redirect URL / 域名策略。

#### 二、Phase 1 任务拆解

`1. 整理 Phase 1 实施输入清单与默认假设`
- 类型：AI任务
- 目标：把 Phase 1 落地所需但尚未明确的输入项整理成可确认清单。
- 产出物：输入清单，包含 OAuth scopes、具体 webhook topics、`scan_scope_flags` 默认值、App URL、Redirect URL、域名方案、环境变量列表。
- 依赖关系：无
- 备注：该任务只产出建议与缺口，不替代最终人工拍板。

`2. 确认关键平台参数与业务默认值`
- 类型：人工任务
- 目标：确认 Phase 1 中必须人工决定的 scopes、webhook topic 展开方式和默认字段值。
- 产出物：已确认参数表，可直接写入代码和平台配置。
- 依赖关系：1
- 备注：涉及业务规则和平台实际注册能力，必须人工确认。

`3. 创建 Shopify Partner App、开发店铺并生成 API 凭证`
- 类型：人工任务
- 目标：在 Shopify Partner 后台创建应用并拿到开发联调用的真实凭证。
- 产出物：Partner App、开发店铺、API Key、API Secret、安全保存记录。
- 依赖关系：2
- 备注：涉及账号登录、权限授予、凭证创建与安全保存。

`4. 创建 Railway 项目与基础资源`
- 类型：人工任务
- 目标：创建 Railway 项目及 `postgres`、`redis` 资源，并确定开发域名方案。
- 产出物：Railway 项目、Postgres 实例、Redis 实例、可用服务地址或域名方案。
- 依赖关系：无
- 备注：涉及账号登录、资源创建、可能的域名或 DNS 操作。

`5. 搭建 Remix + TypeScript 的 Shopify App 代码骨架`
- 类型：AI任务
- 目标：生成可承载 Embedded App 的基础项目结构。
- 产出物：基础代码仓结构、`package.json`、TypeScript 配置、Remix 路由骨架、Shopify App 基础目录。
- 依赖关系：1
- 备注：可基于官方模板结构生成，但不包含真实平台登录步骤。

`6. 接入 Prisma、BullMQ 与基础开发脚本`
- 类型：AI任务
- 目标：把数据库、队列和常用脚本接入项目。
- 产出物：Prisma 初始化文件、BullMQ 基础封装、开发与构建脚本、基础目录约定。
- 依赖关系：5

`7. 设计并编写 Phase 1 的 Prisma Schema`
- 类型：AI任务
- 目标：定义 `shops`、`sessions`、`webhook_event` 三张表及关键索引。
- 产出物：`schema.prisma`，包含 `shop_domain`、`installed_at`、`uninstalled_at`、`current_plan=FREE`、默认 `scan_scope_flags`、加密 token 字段、webhook 幂等字段等。
- 依赖关系：2、6

`8. 生成初始数据库迁移与 Prisma Client`
- 类型：AI任务
- 目标：把 Phase 1 schema 固化为可执行迁移。
- 产出物：初始 migration 文件、Prisma Client 初始化代码。
- 依赖关系：7

`9. 定义环境变量契约与结构化日志基座`
- 类型：AI任务
- 目标：统一环境变量读取、校验和日志输出方式。
- 产出物：`.env.example`、环境变量校验模块、结构化 logger、基础错误处理封装。
- 依赖关系：5
- 备注：真实 secret 值仍需人工在平台中录入。

`10. 编写 Offline Access Token 的 AES-256-GCM 加密模块`
- 类型：AI任务
- 目标：实现 access token 的加密、解密与安全存储封装。
- 产出物：加密工具模块、调用示例、错误处理逻辑。
- 依赖关系：9

`11. 实现 Prisma Session Storage`
- 类型：AI任务
- 目标：让 Shopify Session 持久化到 PostgreSQL。
- 产出物：Session Storage 适配代码、读写删除接口、与 Shopify app 配置的集成代码。
- 依赖关系：7、8、9

`12. 实现 Shopify OAuth 安装入口与回调流程`
- 类型：AI任务
- 目标：完成 Embedded App 的安装认证主链路。
- 产出物：OAuth 路由、安装入口、回调处理、offline token 获取逻辑。
- 依赖关系：2、3、9、11
- 备注：代码可由 AI 完成，但真实认证联调要等人工提供凭证与平台配置。

`13. 实现安装完成后的 `shops` 初始化写入逻辑`
- 类型：AI任务
- 目标：在安装成功时写入店铺基础数据和加密 token。
- 产出物：`shops` upsert 逻辑，包含 `shop_domain`、`installed_at`、`current_plan=FREE`、默认 `scan_scope_flags`、`access_token_encrypted`。
- 依赖关系：7、10、12

`14. 实现 Webhook Topic 定义与注册服务`
- 类型：AI任务
- 目标：把 `APP_UNINSTALLED`、GDPR 三类、`BULK_OPERATIONS_FINISH`、产品与集合相关 topics 注册逻辑接入安装流程。
- 产出物：webhook topic 常量、注册服务、安装后自动注册调用代码。
- 依赖关系：2、12
- 备注：`products/*`、`collections/*` 需要先由人工确认展开后的具体 topics。

`15. 实现 BullMQ 队列封装与空 Worker`
- 类型：AI任务
- 目标：建立 Redis 队列连接和 `worker` 服务的最小可运行骨架。
- 产出物：queue 封装、job 入队接口、空 processor、worker 启动入口。
- 依赖关系：6、9

`16. 实现 Webhook Receiver 路由`
- 类型：AI任务
- 目标：完成 webhook 的 HMAC 校验、幂等落库、快速返回 200 和入队。
- 产出物：Webhook 接收路由、HMAC 校验逻辑、`webhook_event` 幂等写入、BullMQ 投递逻辑。
- 依赖关系：7、9、15

`17. 实现 `APP_UNINSTALLED` Handler`
- 类型：AI任务
- 目标：在应用卸载后标记店铺为已卸载。
- 产出物：`APP_UNINSTALLED` 处理器，更新 `shops.uninstalled_at`，保留事件审计记录。
- 依赖关系：13、16

`18. 实现 GDPR Webhook 占位 Handler`
- 类型：AI任务
- 目标：实现 GDPR 三类 webhook 的最小可用处理，确保稳定返回 200。
- 产出物：`customers/data_request`、`customers/redact`、`shop/redact` 占位处理器。
- 依赖关系：16

`19. 搭建 App Bridge + Polaris 的 Embedded Shell 页面`
- 类型：AI任务
- 目标：让应用可以在 Shopify Admin iframe 中打开并显示空壳页面。
- 产出物：基础 layout、App Bridge 集成、Polaris 页面框架、导航占位页面 `Dashboard / Review / History / Billing / Settings / Help`。
- 依赖关系：5

`20. 编写 Railway 部署配置`
- 类型：AI任务
- 目标：让项目具备在 Railway 上部署 `web` 与 `worker` 的配置文件和启动命令。
- 产出物：Dockerfile 或启动脚本、`railway.json` 或等效配置、`web`/`worker` 启动命令、健康检查约定。
- 依赖关系：6、9、15、19

`21. 编写联调与验收文档`
- 类型：AI任务
- 目标：把安装、部署、Webhook 验证和验收步骤整理成可执行清单。
- 产出物：Phase 1 联调手册、验收 checklist、常见错误排查文档。
- 依赖关系：12、14、16、17、18、19、20

`22. 在 Railway 注入真实环境变量并部署服务`
- 类型：人工任务
- 目标：将真实 secrets 配入 Railway，启动 `web`、`worker`，并连接 `postgres`、`redis`。
- 产出物：已部署的 Railway `web` / `worker` / `postgres` / `redis` 四个 Service。
- 依赖关系：3、4、20
- 备注：涉及真实密钥录入、平台操作和生产式资源访问，必须人工完成。

`23. 在 Shopify 平台同步应用配置`
- 类型：人工任务
- 目标：把真实 App URL、Redirect URL、scopes、embedded 设置和 webhook 配置同步到 Shopify。
- 产出物：已生效的 Shopify 应用配置。
- 依赖关系：2、3、22
- 备注：可通过 Partner Dashboard 或已登录的 Shopify CLI 完成，本质上都属于受权限保护的平台操作。

`24. 执行数据库迁移并安装 App 到开发店铺`
- 类型：人工任务
- 目标：在真实环境执行迁移后，把 App 安装到开发店铺并跑通 OAuth。
- 产出物：已建表数据库、已安装应用的开发店铺、可打开的 Embedded iframe 页面。
- 依赖关系：8、22、23
- 备注：涉及真实店铺登录、授权同意和外部回调验证。

`25. 触发 Webhook 联调并核验日志与数据`
- 类型：人工任务
- 目标：验证卸载和 GDPR webhook 是否能被真实接收、落库和记录日志。
- 产出物：`webhook_event` 落库记录、`shops.uninstalled_at` 更新结果、Railway 日志截图或核验记录、四个 Service healthy 结果。
- 依赖关系：24
- 备注：需要真实卸载、真实 webhook 投递和平台日志查看，AI 无法独立完成。

`26. 完成 Phase 1 最终验收`
- 类型：人工任务
- 目标：根据验收标准确认 Phase 1 是否可收口进入下一阶段。
- 产出物：Phase 1 验收结论与问题清单。
- 依赖关系：25
- 备注：属于最终上线前责任确认与人工验收。

#### 三、AI 执行建议
- 最适合直接交给 AI 连续完成的是 5 到 21，这一段基本都是代码、配置、Schema、空壳 UI、部署文件和联调文档，适合一次性串行产出。
- 最应尽早完成的人工任务是 2、3、4；最容易阻塞后续联调的是 22、23、24。尤其 scopes、webhook topics、Partner App 凭证、Railway 资源和真实 URL 一旦拖后，OAuth、Webhook 注册和部署都会反复返工。