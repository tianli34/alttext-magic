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

- Task 4.1：实现 `GET /api/dashboard` 路由与 Dashboard 统计服务；基于 `candidate_group_projection` 单 SQL 聚合返回 scope 内分组统计、`lastPublishedAt` 与 `isScanning`；补充服务单测。

