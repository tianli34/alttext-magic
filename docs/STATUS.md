## Completed
- 已配置 Shopify 嵌入式应用外壳、模板认证和 Prisma 会话存储
- 授权后已自动 upsert 店铺记录并保存加密离线令牌
- 已完成第一阶段 Webhook 注册
- 已完成 Webhook 接收鉴权、幂等落库、BullMQ 入队与 worker 处理闭环
- 已完成 Embedded App 壳层导航与 Dashboard/Review/History/Billing/Settings/Help 占位页
- 已完成 shops 表 seed 脚本（prisma/seed.ts）写入 3 条测试记录，含 AES-256-GCM 加密 token
- 已完成数据库完整性验证（verify-shops.ts）：shopDomain / installedAt / currentPlan=FREE / scanScopeFlags / accessTokenEncrypted 非空、加密解密 round-trip 通过

## In Progress
- Phase 1：Railway 部署管线
