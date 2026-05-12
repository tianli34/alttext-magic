-- Phase 5 Task 5.1: Billing / Credit Schema 补齐
-- 变更内容：
--   1. BillingInterval 枚举添加 NONE
--   2. billing_subscription 添加 first_paid_welcome_granted_at / incremental_scan_enabled
--   3. credit_bucket 添加 remaining_amount（含回填）
--   4. credit_ledger 添加 reason / metadata
--   5. credit_reservation 添加 batch_id + unique(shop_id, batch_id)
--   6. overage_pack_purchase 添加 price_cents / currency_code

-- 1. BillingInterval 枚举：添加 NONE
ALTER TYPE "BillingInterval" ADD VALUE 'NONE';

-- 2. billing_subscription：添加字段
ALTER TABLE "billing_subscription" ADD COLUMN "first_paid_welcome_granted_at" TIMESTAMP(3);
ALTER TABLE "billing_subscription" ADD COLUMN "incremental_scan_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 3. credit_bucket：添加 remaining_amount 字段（先用默认值 0，再回填）
ALTER TABLE "credit_bucket" ADD COLUMN "remaining_amount" INTEGER NOT NULL DEFAULT 0;
UPDATE "credit_bucket" SET "remaining_amount" = "granted_amount" - "reserved_amount" - "consumed_amount";

-- 4. credit_ledger：添加 reason / metadata
ALTER TABLE "credit_ledger" ADD COLUMN "reason" TEXT;
ALTER TABLE "credit_ledger" ADD COLUMN "metadata" JSONB;

-- 5. credit_reservation：添加 batch_id + 唯一约束
ALTER TABLE "credit_reservation" ADD COLUMN "batch_id" TEXT;
CREATE UNIQUE INDEX "credit_reservation_shop_id_batch_id_key" ON "credit_reservation"("shop_id", "batch_id");

-- 6. overage_pack_purchase：添加 price_cents / currency_code
ALTER TABLE "overage_pack_purchase" ADD COLUMN "price_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "overage_pack_purchase" ADD COLUMN "currency_code" TEXT NOT NULL DEFAULT 'USD';
