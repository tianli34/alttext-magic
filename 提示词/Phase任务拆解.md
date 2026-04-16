




【任务】
将 Phase 3 拆解为适合 Agent 执行的任务


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
| 2 | 数据模型与核心服务层 | 完整 Schema 迁移 + Scope/Mutex/Notice 服务 |
| 3 | 全量扫描管线 | Bulk 提交 → 流式解析 → Staging → Derive → 原子发布 |
| 4 | 仪表盘、候选列表与装饰性标记 | Dashboard 分组统计 + 候选展示投影 + 装饰性标记 |

---

### Phase 3：全量扫描管线

**阶段目标**  
实现完整的 Catalog Scan 管线：从用户首次确认说明并点击“开始扫描”，到 Bulk 提交、流式下载与解析、Staging 落库、Derive 到待发布结果、原子发布到已发布表。此阶段结束后，扫描完成可产生正确的 `alt_target` / `image_usage` / `alt_candidate` / `candidate_group_projection` 数据。

**功能范围**

| # | 功能项 | 对应架构 |
|---|--------|----------|
| 3.1 | 首次扫描说明页前端（Polaris 组件：范围说明、用途、留存期限、AI 边界、scope 勾选） | §4.2.1 |
| 3.2 | `POST /api/scan/start`：写 `scan_notice_ack` + 更新 `scan_scope_flags` + 获取 SCAN 锁 + 创建 `scan_job` + 按 scope 创建 `scan_task` | §6.1 / §4.3.3–4.3.4 |
| 3.3 | 4 类 Bulk GraphQL 查询定义与真实样本验证 | §4.3.5 |
| 3.4 | `scan_start` BullMQ Job：逐个 task 提交 `bulkOperationRunQuery`，创建 `scan_task_attempt` | §4.3.4 / §4.3.6 |
| 3.5 | `BULK_OPERATIONS_FINISH` Webhook handler：定位 `scan_task_attempt`，更新 `bulk_result_url`，投递 `parse_bulk_to_staging` Job | §4.3.6 |
| 3.6 | `parse_bulk_to_staging` Job：流式下载 NDJSON + 流式解析 + `__parentId` 关联 + batch upsert staging | §4.3.6 |
| 3.7 | Staging 表数据写入：`stg_product` / `stg_media_image_product`（含 `position_index`）/ `stg_media_image_file` / `stg_collection` / `stg_article` | §5.7 |
| 3.8 | Bulk URL 过期恢复：下载失败时标记 attempt FAILED → 创建新 attempt → 重新提交 bulk（`max_parse_attempts` 限制） | §4.3.6 |
| 3.9 | `derive_scan_attempt_to_result` Job：从成功 attempt 的 staging 写入 `scan_result_target` / `scan_result_usage`（含去重：同一 `MediaImage` 只生成 1 条 target） | §4.3.6 Derive 规则 |
| 3.10 | `publish_scan_result` Job：原子发布到 `alt_target` / `image_usage` / `alt_candidate` / `candidate_group_projection` | §4.3.7 |
| 3.11 | `PARTIAL_SUCCESS` 处理：仅成功资源类型替换切片，失败类型保留旧数据 | §4.3.7 切片发布规则 |
| 3.12 | `FILE_ALT` target 存在性判定：基于 `image_usage` PRESENT 集合重算 | §4.3.7 |
| 3.13 | `image_usage` 全量扫描 sweep：成功 task 对应的 `usage_type` 做缺席标记 `NOT_FOUND` | §4.3.8 |
| 3.14 | Candidate 发布收敛规则：根据 target 状态 + decorative_mark + draft 状态派生 candidate status | §4.3.7 Candidate 发布收敛 |
| 3.15 | Group 展示投影重建：按 §4.3.7 规则为 FILE_ALT / COLLECTION / ARTICLE 生成投影 | §4.3.7 Group 展示投影重建 |
| 3.16 | `shops.last_published_scope_flags` / `last_published_at` / `last_published_scan_job_id` 更新 | §4.3.7 发布完成 |
| 3.17 | `GET /api/scan/status` API：返回 task 进度、attempt 状态、publish 状态 | §6.1 |
| 3.18 | SSE 进度推送（`GET /api/sse?batchId=...`）：扫描阶段进度 | §6.1 |
| 3.19 | 前端扫描进度页：骨架屏 / 进度动画 / “正在扫描您的店铺…” | §3 产品意图书 |

**依赖关系**
- 前置：Phase 2（全部表结构、Notice 服务、Scope 服务、Mutex 服务）
- 外部：Shopify Bulk Operations API 可用、真实测试店铺有足够样本数据

**技术方案**
- **运行环境**：
  - PostgreSQL 与 Redis 继续使用本地 `docker-compose` 容器
  - `web` 与 `worker` 在宿主机运行
  - Shopify Bulk 完成通知通过本地 tunnel 回调到宿主机 `web`
- **Bulk 提交**：每个 `scan_task` 独立提交一个 `bulkOperationRunQuery`；Shopify 同一 App 同一 Shop 同时只能有 1 个 running bulk，因此 4 个 task 需串行提交（前一个完成后再提交下一个），或利用 BullMQ 的 delayed job 排队。
- **流式解析**：采用 `fetch → response.body (ReadableStream) → ndjson-parse transform → batch upsert` 管道，禁止整文件读入内存；batch upsert 每 500 行 flush 一次。
- **`__parentId` 关联**：产品媒体的 NDJSON 中，`MediaImage` 行通过 `__parentId` 关联其父 `Product` 行。解析器需维护一个 `parentId → Product` 的内存 Map（按 product 维度，不会超出内存）。
- **`position_index`**：优先读取 Shopify 返回的 position 字段；若不可用，解析器为同一 product 下的 `MediaImage` 按出现顺序赋值 `0, 1, 2, ...`。
- **去重**：derive 阶段对 `scan_result_target` 使用 `ON CONFLICT (shop_id, scan_job_id, resource_type, alt_plane, write_target_id, locale) DO UPDATE` 实现 upsert；同一 `MediaImage` 来自 PRODUCT_MEDIA 和 FILES 两个 task 时合并为一条 `FILE_ALT` target。
- **原子发布**：publish job 在单个 Prisma `$transaction` 中完成所有 upsert + sweep + candidate 收敛 + projection 重建 + shops 字段更新；对于大数据量店铺，可按资源类型切片事务（每个切片独立事务），但需保证同一切片内原子。
- **SSE**：worker 将扫描进度写入 Redis（`scan:progress:{batchId}`），web 端通过 SSE 轮询 Redis 推送给前端。
- **本地调试建议**：
  - 将 4 类脱敏 NDJSON 固化到 `fixtures/` 目录，支持离线回放
  - worker 日志输出 batch/task/attempt 粒度字段，方便在本地终端排查
  - 在本地对“旧结果可读、新结果待发布”的一致性进行人工验证

**验收标准**
1. ✅ 首次打开 App → 展示说明页 → 确认后 → 扫描开始 → 进度可见 → 完成后 `alt_target` / `image_usage` / `alt_candidate` / `candidate_group_projection` 数据正确
2. ✅ 4 类 Bulk 样本脱敏固化，`__parentId` 关联正确，产品媒体 `position_index` 连续
3. ✅ 同一 `MediaImage` 在产品媒体与 Files 中仅生成 1 条 `alt_target(FILE_ALT)`，`image_usage` 有 2 条（PRODUCT + FILE）
4. ✅ 模拟 Bulk URL 403：旧 attempt FAILED → 新 attempt 创建 → 重新 Bulk → 最终成功
5. ✅ 达到 `max_parse_attempts`：task FAILED → scan_job 进入 PARTIAL_SUCCESS 或 FAILED
6. ✅ PARTIAL_SUCCESS：仅成功切片 sweep，失败切片保留旧数据
7. ✅ 扫描进行中，前端始终读取旧已发布结果（或空状态），不出现新旧混杂
8. ✅ 扫描完成后，`shops.last_published_scope_flags` / `last_published_at` 正确更新
9. ✅ SCAN 锁期间，`POST /api/generation/start` 返回 409
10. ✅ 重新扫描按钮可正常触发新一轮全量扫描

---


