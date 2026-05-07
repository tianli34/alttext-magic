已完成 Task 4.3。

实现内容：
- 新增 [candidate-list.server.ts]：基于 `candidate_group_projection` 查询，支持 `group`、`status`、`cursor`、`limit`，并做 effective scope 校验。
- 完成 [api.candidates.tsx]：`GET /api/candidates` 鉴权、参数校验、shop 查找、服务调用。
- 新增 [candidates.service.test.ts]：覆盖产品媒体过滤、`MISSING`、out-of-scope、游标分页、group+status 组合过滤。
