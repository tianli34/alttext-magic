# GDPR 自动删除数据方案（Task 9.5）

本方案针对 Shopify GDPR（通用数据保护条例）的 `SHOP_REDACT`（店铺数据删除）与 `APP_UNINSTALLED`（应用卸载）Webhook（网络钩子）要求，实现安全的、防超时的、符合外键约束的数据库数据全量清理 BullMQ Job（队列任务）。

## 用户审查点 (User Review Required)

> [!IMPORTANT]
> - **PostgreSQL 原生 SQL DELETE LIMIT 局限性**：由于 PostgreSQL 的原生 `DELETE` 语句不支持 `LIMIT` 子句，我们采用通用的 `DELETE WHERE id IN (SELECT id FROM ... LIMIT 1000)` 句式进行分批删除。这可防止一次性删除行数过多导致大表锁死，且保证单次执行高效安全。
> - **三阶段分批循环删除**：每一个表均使用 `while (true)` 循环进行批量删除，直至单次删除行数小于 1000 时跳出。每张表删除完毕后均会记录结构化日志（包含表名、删除总行数、耗时毫秒数）。
> - **全局 Session (会话) 清理**：除店铺业务数据外，也将关联的 `"Session"` (会话表) 记录清除（通过 `shopDomain` 匹配），强制清除该店铺的用户登录会话。

## 待决策问题 (Open Questions)

目前暂无未决的技术问题，设计的删除链已完美解决数据库中的所有外键引用。

## 建议变更 (Proposed Changes)

我们将新建及修改以下文件：
1. **[NEW]** [phase9-delete-order.md](file:///e:/alttext-magic/phase9-delete-order.md)：详细记录 34 张数据库表的删除拓扑排序关系。
2. **[NEW]** [worker/jobs/gdpr/gdprDelete.ts](file:///e:/alttext-magic/worker/jobs/gdpr/gdprDelete.ts)：实现具体的 GDPR 清理任务，通过 `executeRawUnsafe` 进行防约束报错的原生 SQL 循环删除。
3. **[MODIFY]** [worker/index.ts](file:///e:/alttext-magic/worker/index.ts)：注册 `gdprDeleteWorker`（GDPR删除工作者），在关闭逻辑中优雅释放。
4. **[MODIFY]** [server/queues/gdpr-delete.queue.ts](file:///e:/alttext-magic/server/queues/gdpr-delete.queue.ts)：更新 `GdprDeleteJobData` 接口参数，加入 `shopId` 和 `reason`，完善入队元信息。

---

### 1. 表删除拓扑图与顺序

根据对 `prisma/schema.prisma` 完整关系分析，得到如下无锁外键清理链路：
`audit_log` (审计日志) → `job_item` (作业明细) → `alt_draft` (生成草稿) → `decorative_mark` (装饰标记) → `candidate_group_projection` (分组投影) → `alt_candidate` (候选Alt) → `image_usage` (图片使用) → `alt_target` (Alt目标) → `scan_result_usage` (扫描使用) → `scan_result_target` (扫描目标) → `stg_product` (暂存产品) → `stg_media_image_product` (暂存媒体) → `stg_media_image_file` (暂存文件) → `stg_collection` (暂存集合) → `stg_article` (暂存文章) → `scan_task_attempt` (扫描尝试) → `scan_task` (扫描任务) → `scan_job` (扫描作业) → `credit_ledger` (额度流水) → `credit_reservation_line` (保留明细) → `credit_reservation` (额度保留) → `credit_bucket` (额度桶) → `billing_ledger` (账单流水) → `overage_pack_purchase` (超额包) → `billing_subscription` (账单订阅) → `webhook_events` (网络钩子事件) → `job_batch` (作业批次) → `generation_batch` (生成批次) → `ai_model_call` (模型调用) → `resource_image_fingerprint` (指纹) → `shop_operation_lock` (操作锁) → `scan_notice_ack` (通知确认) → `"Session"` (会话表) → `"shops"` (店铺表)

该顺序已记录在 [phase9-delete-order.md](file:///e:/alttext-magic/phase9-delete-order.md) 中。

---

### 2. GDPR 清理 Job 实现

在 [worker/jobs/gdpr/gdprDelete.ts](file:///e:/alttext-magic/worker/jobs/gdpr/gdprDelete.ts) 中，我们将：
- 支持幂等校验：`SELECT 1 FROM "shops" WHERE "id" = $1`（利用 Prisma Client (客户端) 完成）。若无数据，打日志 `skipped: already_deleted` 并提前退出。
- 按顺序定义每张表的删除语句。
- 特殊处理：`job_item` 使用子查询根据 `job_batch` 清理；`webhook_events` 和 `"Session"` 使用 `shopDomain` 清理；其它的表均通过 `shop_id` 字段清理。
- 逐个表进行循环，当单次删除行数小于 1000 时，代表该表已完全清除，进入下一张表。

## 验证计划 (Verification Plan)

### 自动化单元与集成测试

我们将编写一个测试脚本（或通过模拟任务触发），流程如下：
1. 向 `shops` 插入测试店铺 `test-shop-id`，同时在各个关联明细表中写入含有 `shop_id = 'test-shop-id'` 的假数据。
2. 调用 `enqueueGdprDelete` 将清理任务入列。
3. 检查 Worker 日志，验证每张表的 `deleted_rows` 与耗时被正确输出。
4. 验证数据库中关联 `test-shop-id` 的数据全部归零。
5. 再次调用该清理任务，验证日志中出现 `skipped: already_deleted`。
