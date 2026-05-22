-- AlterTable: 在 shops 表新增 incremental_scan_enabled 字段
-- 用于在 Shop 级别快速判断增量扫描是否启用，避免联表查询 billing_subscription
ALTER TABLE "shops" ADD COLUMN "incremental_scan_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 回填：如果 shop 当前计划为付费计划（非 FREE），则启用增量扫描
UPDATE "shops"
SET "incremental_scan_enabled" = true
WHERE "current_plan" != 'FREE';
