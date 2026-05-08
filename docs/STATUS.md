## Completed
### 1. 已就绪的基础设施
- **技术栈**：Shopify Embedded App (React/Polaris Web Components) + Node.js + Prisma (PostgreSQL) + BullMQ。
- **全局状态与组件**：
  - `/api/bootstrap` 接口已通，可返回套餐配额、`effectiveRead` Scope、上次发布时间及最近扫描状态。
  - Scope 工具已就绪：支持计算 `effective_read_scope_flags`，用于后续数据过滤。
  - 扫描进度组件已就绪：`useScanStatus` hook 与 `ScanStatusBanner` 组件支持 SSE 实时扫描状态，Dashboard 可直接集成以显示“正在重新扫描”状态。

### 2. 数据层上下文
Phase 3 后台扫描已闭环，**Phase 4 绝对禁止读取 staging 表，仅限面向以下已发布模型进行只读/更新**：
- `candidate_group_projection`: 聚合分组主表，Phase 4 列表和统计的主查询入口。
- `alt_candidate` / `alt_target` / `alt_draft`: 候选数据与目标详情（注意：`alt_candidate.status` 需支持更新为 `DECORATIVE_SKIPPED`）。
- `image_usage`: 图片的具体引用位置。复用去重已在底层处理，同一文件在 Product/Files 分组中会自动正确统计。
- `decorative_mark`: 用于 Phase 4 的装饰性标记存储表。
- `shops`: 发布后 `last_published_*` 字段已更新。

## In Progress（本地开发）- Phase 4：仪表盘、候选列表与装饰性标记

- Task 4.1：实现 `GET /api/dashboard` 路由与 Dashboard 统计服务；基于 `candidate_group_projection` 单 SQL 聚合返回 scope 内分组统计、`lastPublishedAt` 与 `isScanning`。
- Task 4.2：Dashboard 前端页面实现。包含：GroupStatsCard、QuotaSummary、相对时间格式化、isScanning 状态提示条、重新扫描按钮、响应式网格布局。
- Task 4.3：实现 `GET /api/candidates` 路由与候选列表服务；支持 group/status 过滤、effective scope 校验和游标分页。
- Task 4.4：实现 `GET /api/candidates/:altCandidateId/usages` 路由与候选 Usage 详情服务；支持 scope 过滤、可选 group 过滤，返回 PRESENT usage 列表含 `shopifyAdminUrl` 跳转链接。
- Task 4.5：实现候选列表前端页面 `/app/candidates`；支持 scope 内 group 筛选、状态筛选、候选信息展示、usage 展开、游标加载更多，并从 Dashboard 缺失数跳转。
- Task 4.6：实现 `POST /api/decorative/mark` 与 `/api/decorative/unmark`；支持归属/scope 校验、幂等标记、事务内联动 `decorative_mark` 与 `alt_candidate.status`。
- Task 4.7：实现候选列表前端页面的装饰性标记与取消交互；支持基于状态动态展示操作按钮、行内防误点确认机制、API 调用与列表状态实时更新、Toast 错误提示，以及与 Dashboard 统计返回自动刷新的数据联动。
