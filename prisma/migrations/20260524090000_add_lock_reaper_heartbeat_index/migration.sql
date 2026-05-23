-- 为 lock-reaper 心跳超时回收查询添加联合索引
-- 查询模式：WHERE status = 'RUNNING' AND heartbeat_at < threshold
-- 对应 Prisma schema 新增的 @@index([status, heartbeatAt])
CREATE INDEX CONCURRENTLY IF NOT EXISTS "shop_operation_lock_status_heartbeat_at_idx"
  ON "shop_operation_lock" ("status", "heartbeat_at");
