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
- P3-01 完成首次扫描说明页前端：
  - `app/components/onboarding/ScanNotice.tsx` — 扫描范围/用途说明/留存期限/AI使用边界四块说明 + 确认勾选
  - `app/components/onboarding/ScopeSelector.tsx` — 4类图片scope复选框 + 全选/取消全选 + 空选校验
  - `app/routes/app.onboarding.tsx` — 说明页路由（loader鉴权+bootstrap判断; 表单校验+提交scan/start+跳转）
  - `app/routes/api.scan.start.tsx` — POST /api/scan/start（鉴权→zod校验→获取锁→ackNotice→updateScope→createJob→入队BullMQ）
- P3-02 完成 `POST /api/scan/start` 核心扫描启动事务：
  - `server/modules/scan/scan.types.ts` — 扫描模块共享类型（CreateScanJobParams/Result、ScanProgressData、ScanStartResponse）
  - `server/modules/scan/scan.constants.ts` — Redis进度键前缀、ScopeFlag→ScanResourceType映射
  - `server/modules/scan/catalog/scan-job.service.ts` — `createScanJobWithTasks` 事务函数（原子创建 scan_job + 按 scope 创建 scan_task）
  - `server/sse/progress-publisher.ts` — Redis进度发布器（`initScanProgress`/`incrementScanProgress`/`getScanProgress`）
  - `app/routes/api.scan.start.tsx` — 完善流程：鉴权→zod校验→获取锁(409冲突)→ackNotice→updateScope→事务创建Job+Tasks→Redis初始化→BullMQ入队→返回scanJobId/batchId/status
  - `tests/api.scan.start.test.ts` — 10条路由层测试（成功/部分scope/非法body/空scope/405/409锁冲突/500+锁释放/404/类型错误）

## In Progress-本地开发
- Phase 3：首次扫描流程
