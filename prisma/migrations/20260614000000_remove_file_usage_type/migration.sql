-- 清理 usageType=FILE 的自指 image_usage 记录
-- FILE 在语义上是图片指向自身（gid://shopify/MediaImage/xxx），不是真正的引用关系
DELETE FROM "image_usage" WHERE "usage_type" = 'FILE';

-- FILES Group projection：纯文件图片未被任何外部资源引用，计数器置 0
UPDATE "candidate_group_projection"
SET "usage_count_present" = 0
WHERE "group_type" = 'FILES';

-- PRODUCT_MEDIA Group projection：旧代码将 FILE 计数混入 usage_count_present，
-- 需要按实际 PRODUCT usage 数量重算
UPDATE "candidate_group_projection" cgp
SET "usage_count_present" = (
  SELECT COUNT(*)
  FROM "image_usage" iu
  WHERE iu."alt_target_id" = cgp."alt_target_id"
    AND iu."usage_type" = 'PRODUCT'
    AND iu."present_status" = 'PRESENT'
)
WHERE cgp."group_type" = 'PRODUCT_MEDIA';
