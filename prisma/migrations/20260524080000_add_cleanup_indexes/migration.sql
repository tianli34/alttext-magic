-- Phase 9: 为 cleanup job 添加必要的索引
-- audit_log.created_at 用于 90 天审计日志清理
-- webhook_events.created_at 用于已处理 webhook 事件 7 天清理

-- audit_log: 清理 WHERE created_at < NOW() - interval '90 days'
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_created_at_idx
  ON audit_log (created_at);

-- webhook_events: 清理 WHERE processed_at IS NOT NULL AND created_at < NOW() - interval '7 days'
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_events_created_at_idx
  ON webhook_events (created_at);
