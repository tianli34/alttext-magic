## Completed
- 已配置 Shopify 嵌入式应用外壳、模板认证和 Prisma 会话存储
- 授权后已自动 upsert 店铺记录并保存加密离线令牌
- 已完成第一阶段 Webhook 注册
- 已完成 Webhook 接收鉴权、幂等落库、BullMQ 入队、worker 处理闭环
- 已完成 Embedded App 壳层导航：Dashboard/Review/History/Billing/Settings/Help 占位页
- server\config\constants.ts
- 新增 scope flags 校验、去重、排序工具函数与测试
- 已补齐Prisma Schema 所有表与关系
- 已生成 Phase 2 核心 schema migration，并新增数据库核心表与关键唯一索引校验脚本
- 安装完成时在 shop upsert 事务内幂等初始化 `WELCOME(50)` 与当月 `FREE_MONTHLY_INCLUDED(25)` buckets
- 完成 scan_notice_ack 基础服务：`ackNotice` upsert 确认、`getNoticeStatus` 版本检查、纯函数 `checkNeedsAck`
- 完成 scope 服务：`getScopeSettings`、`updateScanScopeFlags`、`computeEffectiveReadScopeFlags`，默认四类全开，非法 flag zod 报错
- 完成 `shop_operation_lock` 服务：`acquireLock` / `releaseLock` / `heartbeatLock` / `cleanupExpiredLocks` 与集成测试
- 完成 Bootstrap 聚合服务 `getBootstrapData` 及 `GET /api/bootstrap` 路由：聚合返回计划占位、额度占位、notice 状态、scope 三件套（scan / lastPublished / effectiveRead）、最近扫描状态
- 完成 `POST /api/settings/scope` 路由：校验登录态/shop上下文、body flags 校验、调用 `updateScanScopeFlags`、返回 ScopeSettings

### Phase 3
- 完成首次扫描说明页前端（`ScanNotice.tsx` 四块说明+确认勾选、`ScopeSelector.tsx` 四类scope复选框）及 `app.onboarding.tsx` 路由（鉴权、表单校验、提交跳转）
- 完成 `POST /api/scan/start`：鉴权 → zod校验 → 获取锁（409冲突）→ ackNotice + updateScope → 事务创建 scan_job/scan_task → Redis初始化进度 → BullMQ入队；含10条路由层测试
- 完成 `GET /api/scan/status`：鉴权 → 并行查 scan_job/tasks/attempts + Redis进度 → 返回完整状态
- 完成 4 类 Bulk GraphQL 查询定义与真实样本验证
- 完成 `scan_start` Worker 并行 Bulk 提交：新增 `BulkSlotManager` / `BulkSubmitService`、`trySubmitNextBatch(scanJobId)`、`BULK_OPERATIONS_FINISH` webhook 补位提交与 attempt/bulk_operation_id 落库日志
- 完成 `BULK_OPERATIONS_FINISH` 终态收敛与并发补位：新增 parse 入队、Shop 级 Redis 槽位锁、重复 webhook 幂等与并发测试
- 完成流式 NDJSON 解析基础设施：通用流式 parser、4 类资源 parser callback、`__parentId` 缓存映射、staging batch flush 组件、fixture 回放入口、parse-bulk worker 注册
- 完成 Staging 写入闭环：5 张 staging 表 batch upsert（stg_product/stg_media_image_product/stg_media_image_file/stg_collection/stg_article）、`__parentId` 关联、position_index 优先 Shopify 字段 + 0-based fallback、parse 成功后投递 derive job
- 完成 parse_bulk_to_staging 过期恢复：403/404/过期/超时等下载失败分类、按 `max_parse_attempts` 自动重提 bulk、超限 task 失败收敛与测试
- 完成 derive_scan_attempt_to_result：从 staging upsert `scan_result_target/scan_result_usage`，实现 `FILE_ALT` 跨 `PRODUCT_MEDIA/FILES` 单 target 去重、双 usage 保留，并补齐 derive/parse 交接与幂等测试
- 已收紧结果层 schema：`scan_result_target` 唯一键改为 target 级 `(shopId, scanJobId, altPlane, writeTargetId, locale)`，并新增迁移去除 `resourceType` 造成的 FILE_ALT 双 target 张力
- 完成 `publish_scan_result`：新增 publish 队列/worker，单事务按成功资源类型发布 `alt_target` / `image_usage`、失败切片保留旧发布、成功切片 sweep 为 `NOT_FOUND`，并收敛 `alt_candidate` / `candidate_group_projection`
- 完成 publish 后收敛补强：发布成功后更新 `shops.last_published_*`、`FILE_ALT` 按 `image_usage PRESENT` 重算 target 存在性，`FAILED`/publish 完成后释放 SCAN 锁
- 完成 SSE 进度推送 + 扫描进度页前端（P3-13）：Worker 关键阶段写 Redis 进度（started→bulk_submitted→parsing→derive→publish→done/failed）、`GET /api/sse` 轮询式 SSE 端点、`useSSE`/`useScanStatus`/`useBatchProgress` hooks、`ProgressBar`/`StatusBadge`/`ScanStatusBanner` 组件、Dashboard 进度页集成

## In Progress-本地开发
- Phase 3：全量扫描管线
