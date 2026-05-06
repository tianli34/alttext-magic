



【任务】
将 Phase 4 拆解为适合 Agent 执行的任务（无需并行）



【背景】
# AltText Magic — 分阶段开发计划（省略版）

## 1. 项目概览

**AltText Magic** 是一款面向 Shopify 中小商家的嵌入式 App（Embedded App），通过 AI 在“可控、可审阅”的前提下，批量为店铺四类图片资源（产品媒体 / 文件库 / 集合封面 / 文章封面）补齐缺失的 Alt Text。MVP 需完整跑通 **“扫描 → 生成 → 审阅 → 写回”** 安全闭环，并支持装饰性图片标记、共享文件影响范围提示、Freemium 五档计费与超额包、付费计划专属增量扫描等能力。

**技术栈**：Node.js + TypeScript / React Router（Web）/ Prisma + PostgreSQL / Redis + BullMQ / Shopify App Bridge + Polaris Web Components / AI Gateway（主模型 + 降级模型）。

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
| 3 | 全量扫描管线 | Bulk 提交 → 流式解析 → Staging → Derive → 原子发布 |
| 4 | 仪表盘、候选列表与装饰性标记 | Dashboard 分组统计 + 候选展示投影 + 装饰性标记 |
| 5 | 计费与配额系统 | 五档订阅 + 欢迎额度 + Free 月配额 + 超额包 + 额度预留 |
……

---

## Phase 4：仪表盘、候选列表与装饰性标记

**阶段目标**  
在 Phase 3 产出的已发布数据之上，构建用户可交互的仪表盘分组统计、候选列表（含展示投影、共享文件提示）以及装饰性图片标记功能。此阶段结束后，用户可查看扫描结果、浏览缺失图片列表、标记/取消装饰性图片。

**功能范围**

| # | 功能项 | 对应架构 |
|---|--------|----------|
| 4.1 | `GET /api/dashboard` API：按 `effective_read_scope_flags` 过滤，基于 `candidate_group_projection` 统计 `total / hasAlt / missing / decorative` | §4.4 |
| 4.2 | Dashboard 前端页面（Polaris Web Components）：四组卡片 + 当前计划与配额摘要（占位） + `lastPublishedAt` + “正在重新扫描”状态提示 + “重新扫描”按钮 | §4.4 |
| 4.3 | `GET /api/candidates` API：支持 `group` / `status` 过滤 + 分页；基于 `candidate_group_projection + alt_candidate + alt_target + alt_draft` 联查 | §6.1 |
| 4.4 | `GET /api/candidates/:altCandidateId/usages` API：返回 PRESENT 的 usage 列表 | §6.1 |
| 4.5 | 候选列表前端页面（Polaris Web Components）：缩略图 / 图片类型标签 / 主标题（`primaryUsage.title`）/ 位置 / `additionalUsageCount` / `usageCountPresent` / `contextMode` / 状态标签 / 展开影响范围详情 | §4.7 |
| 4.6 | `POST /api/decorative/mark` 与 `POST /api/decorative/unmark` API | §4.5 |
| 4.7 | 装饰性标记前端交互：每张图片旁的标记/取消切换 | §4.5 |
| 4.8 | 标记联动：mark 时 candidate → `DECORATIVE_SKIPPED`，missing -1 / decorative +1；unmark 时反向恢复 | §4.5.1–4.5.2 |
| 4.9 | out-of-scope group 不展示、不允许操作 | §4.2.2 C |

**依赖关系**
- 前置：Phase 3（已发布扫描结果、`candidate_group_projection`、`alt_candidate`）
- 前置：Phase 2（`effective_read_scope_flags` 计算、`decorative_mark` 表）

**技术方案**
- **Dashboard 统计**：单条 SQL 聚合查询，以 `candidate_group_projection.group_type` 分组，关联 `alt_target.current_alt_empty` 和 `decorative_mark.is_active` 计算四个指标；WHERE 条件限定 `group_type IN (effective_read_scope_flags 对应的 group 类型)`。
- **候选列表**：基于 `candidate_group_projection` 做主查询，LEFT JOIN `alt_candidate` / `alt_target` / `alt_draft`；分页使用 cursor-based pagination（`id > :lastId LIMIT 20`）。
- **Usage 详情**：独立 API 只在前端展开“影响范围”时调用，避免列表页 N+1。
- **装饰性标记**：`decorative_mark` upsert 在事务内完成，同事务更新 `alt_candidate.status`；标记/取消后 Dashboard 需重新 fetch。
- **本地运行注意**：
  - 数据库统计查询在本地 Docker PostgreSQL 上先验证 Explain 计划
  - 本地前端与宿主机 `web` API 同源或通过 dev proxy 连接
  - 候选列表与 Dashboard 的读模型继续只读已发布结果，避免与扫描中的 staging 混读

**验收标准**
1. Dashboard 四组统计数字与 `candidate_group_projection` 数据一致
2. 同一共享文件同时出现在 Product Media 与 Files 两组统计中
3. 候选列表按 group 过滤后，`primaryUsage.title` / `positionIndex` / `additionalUsageCount` 正确展示
4. 用户取消 scope 中的 Collection 后，Dashboard 不再展示 Collection 分组，`GET /api/candidates?group=COLLECTION` 返回空
5. 标记装饰性 → missing 减 1、decorative 加 1；取消标记 → 反向恢复
6. 已标记装饰性的候选不可进入后续生成/写回操作入口

---


