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

## In Progress-本地开发
- Phase 2：数据模型与核心服务层
