# Completed (Phase 1–8 摘要)

- 数据模型：shops 表含 `scan_scope_flags`、`incremental_scan_enabled`；billingSubscription 记录订阅计划；审计记录通过 `GET /api/history` + 前端历史页呈现。
- 锁机制：Redis writeback-lock（SET NX PX）+ PG SCAN 锁互斥（`isOperationRunning`），continuous-scan worker 亦通过 lockGate 防冲突。
- BullMQ 基础设施：writeback 队列 + continuous-scan 队列（debounce/product/collection 三个独立 Worker），SSE 进度推送模式已建立。
- 门控体系：planGate（读 shops.incremental_scan_enabled）、scopeGate（读 shops.scan_scope_flags）、fingerprintGate、lockGate 四层已就绪。
- 订阅联动：apply-subscription-change / plan-change / subscription.service 三处双写 billingSubscription + shop，Free↔Paid 切换已覆盖测试。
- Webhook 流水线：webhook-event.service 负责 debounce 入队 + 状态流转（COALESCED→PROCESSING→PROCESSED/SKIPPED/FAILED）。
- 写回 & 审计：WritebackRouter → file/collection/article executor，成功/跳过/失败均落库审计。
- AI 管线：AIGatewayService 统一路由 + FallbackProvider 多级降级，批量生成已完成。
- GDPR：尚未完整实现，Phase 9 需补齐。Settings 页面、数据留存清理、锁超时回收、可观测性埋点均为 Phase 9 新增。

## Phase 9：设置、清理与运维收尾
- Task 9.0:`shared/logger/` 占位；`cleanup`/`gdpr-delete`/`lock-reaper` 三个 Queue 名常量及桩声明完成
- Task 9.1: `GET /api/settings` 返回 scope/plan/helpLinks；`PUT /api/settings/scopes` 更新 scan_scope_flags 不触发扫描；完整 Settings 页面（scope 复选框+计划卡片+帮助链接+保存按钮+toast）
- Task 9.10: `altDraftRepo` + `findActive*` 方法封装 `expiresAt > NOW()` 过滤；所有 7 处 draft read（candidate-list/review-list/draft.service/writeback.processor/writeback.service/decorative-mark×2）已统一过滤；processor 改用共享 `computeExpiresAt()`；migration 含历史回填
- Task 9.7: 实现 `shared/logger/` 结构化日志库，挂载 Web 端 `pino-http` 日志拦截与 Worker 端 `withJobLogger` 任务包装，并规范化了全部 6 个核心处理器的日志字段输出。
- Task 9.2: 实现 Cleanup BullMQ Repeatable Job（5 子任务：过期 AltDraft / 90 天审计日志 / 7 天 staging+scan_result / 7 天失败 attempt / 7 天已处理 webhook）；cron `0 2 * * *`；migration 新增 `audit_log_created_at_idx` + `webhook_events_created_at_idx` 索引；EXPLAIN 分析完成。
- Task 9.5: 实现 `gdpr_delete` BullMQ Job（34 表拓扑顺序分批删除 + 幂等校验 + 结构化日志）；`gdpr-delete.queue.ts` 接口增加 `shopId`/`reason`；Worker 注册至 `worker/index.ts`；
- Task 9.4: `APP_UNINSTALLED` webhook 完整实现：鉴权 → 幂等持久化 → 同步清空 shop accessToken + 标记 uninstalledAt → 入列 gdpr-delete → 返 200
