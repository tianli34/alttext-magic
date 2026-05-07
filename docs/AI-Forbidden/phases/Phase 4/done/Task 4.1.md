已完成 Task 4.1。

实现内容：
- 新增 `GET /api/dashboard` 路由：[api.dashboard.tsx]
- 新增 Dashboard 服务与类型：[dashboard.service.ts]、[dashboard.types.ts]
- 基于 `effective_read_scope_flags` 映射允许的 `group_type`
- 使用单条 SQL 聚合 `total / hasAlt / missing / decorative`
- 返回 `{ groups, lastPublishedAt, isScanning }`
- 更新 [docs/STATUS.md]

验证：
- `npx tsx tests/dashboard.service.test.ts` 通过
- `npx tsx tests/api.dashboard.test.ts` 通过
- `npm run typecheck` 通过
- 已用 `EXPLAIN` 验证：查询从索引扫描进入，无全表扫描；`candidate_group_projection`、`alt_target`、`decorative_mark` 均走索引访问。

补充说明：`docs/Specs/6.1` 提到 `/api/dashboard` 可返回 plan/quota/scope 元信息，但本任务明确指定响应结构只有 `groups / lastPublishedAt / isScanning`，所以本次按任务验收口径实现。另有 `docs/AI-Forbidden/*` 相关未提交变更已存在，我没有触碰。
