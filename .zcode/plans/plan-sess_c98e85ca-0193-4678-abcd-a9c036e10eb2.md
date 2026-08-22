# 接手完成 SCAN 职责越界修复（Phase10 分支）

Codex 已完成大部分接线，但有明确中断点。本计划：完成收尾 + 补齐超时进度清理 + 启动失败收敛 + Webhook 模块迁移。**publish.service 本次不拆**（用户已确认）。

## 1. 修复 scan-lifecycle.service.ts 语法错误（P0 收口）

- 文件末尾缺少一个闭合 `}`（第 32 行处 TS1005），补上。
- 该文件 `reconcileScanJobLifecycle` 即统一终态编排入口：finalize → setScanProgressStatus → FAILED 释放锁 / 否则入 publish 队列。4 个消费方（scan-start / scan-timeout / parse-bulk / derive-scan）已接入，无需改动逻辑。

## 2. 超时路径恢复进度清理能力

- scan-timeout.service.ts 重构后丢失了 `deleteScanProgress`；`redisDeletedCount` 恒为 0。
- 在 `timeoutStaleRunningScans` 调用 `reconcileScanJobLifecycle` 后追加 `await deleteScanProgress(scanJobId)`，并计入 `redisDeletedCount`。
- 清理 scan-timeout.service.ts 中提及 `finalizeScanJobIfTerminal` 的过时注释（第 182 行附近，改为提 reconcileScanJobLifecycle）。

## 3. Webhook 模块完整迁移到 server/modules/webhook/（P2）

- 迁移 `app/lib/server/webhooks/` 剩余 4 个文件（webhook.repository.ts / webhook.types.ts / webhook-receive.service.ts / webhook.queue.ts）到 `server/modules/webhook/`，统一修正相对导入深度与文件头注释；已迁入的 webhook-process.service.ts 修复其 `../../../../` 错误路径。
- 更新引用方导入（保持项目 `.js` 后缀习惯）：
  - `worker/index.ts:6`（当前指向已删除的旧路径，必然编译失败）与 `:28` 类型导入；
  - app 内 webhook HTTP 路由（app/routes/webhooks.*）、tests/webhook-idempotency.e2e.ts。
- HTTP route 保持「鉴权 → 幂等持久化 → 入队 → 200」，业务逻辑全部留在 server 模块 + Worker（现状已符合，仅迁移位置）。

## 4. 启动路径失败即收敛（P2，用户选定方案）

- app/routes/api.scan.start.tsx：在 `createScanJobWithTasks` 之后的 `initScanProgress` / `enqueueScanStart` 失败分支，catch 中将该 scanJob 及其 tasks 事务性标记 FAILED（error 记为投递失败原因）、`releaseLockByType(shopId, "SCAN")`，再返回错误响应——不再留下 RUNNING 孤儿等 10 分钟超时。

## 5. 同步测试 mock

- tests/parse-bulk.retry.test.ts、tests/derive-scan.test.ts、tests/bulk-operations-finish.webhook.test.ts 目前仍注入/断言 `finalizeScanJobIfTerminal`，改为 mock `reconcileScanJobLifecycle`（含 setScanProgressStatus / releaseLockByType / enqueuePublishScanResult 的副作用断言随依赖结构调整）。
- tests/webhook-idempotency.e2e.ts 更新迁移后的导入路径。

## 6. 验证

- `npx tsc --noEmit -p tsconfig.json` 与 `-p tsconfig.worker.json` 双目标零错误。
- 运行现有测试脚本（tests/*.test.ts，按项目现有运行方式）。
- 不删除仓库根的 `$null` / `session-ses_00a5.md` 残留文件（非本任务产物，保留给用户处理）。

## 不做的事（明确排除）

- publish.service.ts 拆分（用户确认本次不拆）。
- 不新增 outbox 表/迁移。
- scan-start.service 内部的 BulkSubmissionService / BulkCompletionHandler 进一步拆文件——终态收敛已由 lifecycle 服务统一，本次不再扩大改动面。