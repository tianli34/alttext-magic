-- Phase: 写回审计（audit_log）改为追加式
--
-- 背景：alt_candidate.alt_target_id 唯一 → 候选行跨「清空 Alt → 重扫 → 再次写回」轮次复用。
--       原唯一索引 audit_log(shop_id, write_target_id, alt_candidate_id) 限定每条候选只允许一条审计记录，
--       因此同一候选的第二次写回必然在 tx.auditLog.create() 上触发唯一冲突：
--       Shopify fileUpdate 属外部副作用、不随事务回滚，而 markWritten 事务整体回滚，
--       候选停留在可写回状态被 BullMQ 重试，重试的真值复核读回本次自己写入的 Alt，
--       把成功写回误判为「商家已手动补 Alt」（批次 success=0、审计缺失、候选被置 RESOLVED）。
-- 处置：唯一索引降级为普通索引，审计按写回事件追加；
--       写回落库幂等由已有的 audit_log.idempotency_key 唯一约束承担
--       （取值 writeback:<batchId>:<candidateId>，同批次同候选固定不变）。

-- DropIndex
DROP INDEX IF EXISTS "audit_log_shop_id_write_target_id_alt_candidate_id_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_log_shop_id_write_target_id_alt_candidate_id_idx" ON "audit_log"("shop_id", "write_target_id", "alt_candidate_id");
