-- 目的：将 scan_result_target 的唯一性从 task 级收敛到真正的写回对象级，
-- 使同一 FILE_ALT 在 PRODUCT_MEDIA / FILES 间只能存在 1 条 target。

BEGIN;

ALTER TABLE "scan_result_usage"
  DROP CONSTRAINT IF EXISTS "scan_result_usage_shop_id_scan_job_id_resource_type_alt_pl_fkey";

ALTER TABLE "scan_result_target"
  DROP CONSTRAINT IF EXISTS "scan_result_target_scan_job_id_resource_type_fkey";

WITH ranked_target AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale"
      ORDER BY
        CASE WHEN "resource_type" = 'PRODUCT_MEDIA' THEN 0 ELSE 1 END,
        "updated_at" DESC,
        "created_at" DESC,
        id DESC
    ) AS rn
  FROM "scan_result_target"
)
DELETE FROM "scan_result_target" target
USING ranked_target ranked
WHERE target.id = ranked.id
  AND ranked.rn > 1;

DROP INDEX IF EXISTS "scan_result_target_shop_id_scan_job_id_resource_type_alt_pl_key";

CREATE UNIQUE INDEX "scan_result_target_shop_id_scan_job_id_alt_plane_write_t_key"
  ON "scan_result_target"("shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale");

CREATE INDEX IF NOT EXISTS "scan_result_target_shop_id_scan_job_id_alt_plane_write_t_idx"
  ON "scan_result_target"("shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale");

CREATE INDEX IF NOT EXISTS "scan_result_usage_shop_id_scan_job_id_alt_plane_write_t_idx"
  ON "scan_result_usage"("shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale");

ALTER TABLE "scan_result_usage"
  ADD CONSTRAINT "scan_result_usage_shop_id_scan_job_id_alt_plane_write_ta_fkey"
  FOREIGN KEY ("shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale")
  REFERENCES "scan_result_target"("shop_id", "scan_job_id", "alt_plane", "write_target_id", "locale")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

COMMIT;
