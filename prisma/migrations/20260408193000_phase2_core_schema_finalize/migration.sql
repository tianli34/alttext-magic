-- CreateEnum
CREATE TYPE "ScanJobStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanJobPublishStatus" AS ENUM ('PENDING', 'PUBLISHED', 'NOT_PUBLISHED');

-- CreateEnum
CREATE TYPE "ScanResourceType" AS ENUM ('PRODUCT_MEDIA', 'FILES', 'COLLECTION_IMAGE', 'ARTICLE_IMAGE');

-- CreateEnum
CREATE TYPE "ScanTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanTaskAttemptStatus" AS ENUM ('PENDING', 'RUNNING', 'READY_TO_PARSE', 'PARSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "JobBatchType" AS ENUM ('SCAN', 'GENERATE', 'WRITEBACK');

-- CreateEnum
CREATE TYPE "JobBatchStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "JobItemStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED_ALREADY_FILLED');

-- CreateEnum
CREATE TYPE "ResourceImageFingerprintResourceType" AS ENUM ('PRODUCT', 'COLLECTION');

-- CreateEnum
CREATE TYPE "AltPlane" AS ENUM ('FILE_ALT', 'COLLECTION_IMAGE_ALT', 'ARTICLE_IMAGE_ALT');

-- CreateEnum
CREATE TYPE "ImageUsageType" AS ENUM ('PRODUCT', 'FILE');

-- CreateEnum
CREATE TYPE "PresentStatus" AS ENUM ('PRESENT', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "AltCandidateStatus" AS ENUM ('MISSING', 'GENERATION_FAILED_RETRYABLE', 'GENERATED', 'WRITEBACK_FAILED_RETRYABLE', 'WRITTEN', 'RESOLVED', 'NOT_FOUND', 'DECORATIVE_SKIPPED', 'SKIPPED_ALREADY_FILLED');

-- CreateEnum
CREATE TYPE "AltCandidateMissingReason" AS ENUM ('EMPTY', 'WHITESPACE');

-- CreateEnum
CREATE TYPE "CandidateGroupType" AS ENUM ('PRODUCT_MEDIA', 'FILES', 'COLLECTION', 'ARTICLE');

-- CreateEnum
CREATE TYPE "CandidateGroupPrimaryUsageType" AS ENUM ('PRODUCT', 'FILE', 'SELF');

-- CreateEnum
CREATE TYPE "AltDraftContextMode" AS ENUM ('RESOURCE_SPECIFIC', 'FILE_NEUTRAL', 'SHARED_NEUTRAL');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'COALESCED', 'PROCESSING', 'PROCESSED', 'SKIPPED_PLAN', 'SKIPPED_SCOPE', 'SKIPPED_NO_IMAGE_CHANGE', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingPlanCode" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'PRO', 'MAX');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCEL_SCHEDULED', 'CANCELED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "OveragePackPurchaseStatus" AS ENUM ('PENDING', 'PURCHASED', 'FAILED', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CreditBucketType" AS ENUM ('FREE_MONTHLY_INCLUDED', 'MONTHLY_INCLUDED', 'ANNUAL_INCLUDED', 'WELCOME', 'OVERAGE_PACK');

-- CreateEnum
CREATE TYPE "CreditBucketStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CreditReservationStatus" AS ENUM ('PENDING', 'ACTIVE', 'PARTIALLY_CONSUMED', 'CONSUMED', 'RELEASED', 'EXPIRED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreditLedgerType" AS ENUM ('GRANT', 'RESERVE', 'CONSUME', 'RELEASE', 'EXPIRE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BillingLedgerEntryType" AS ENUM ('SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_EXPIRED', 'OVERAGE_PURCHASED', 'OVERAGE_REFUNDED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BillingLedgerStatus" AS ENUM ('PENDING', 'POSTED', 'VOIDED', 'FAILED');

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "first_paid_bonus_granted_at" TIMESTAMP(3),
ADD COLUMN     "last_published_at" TIMESTAMP(3),
ADD COLUMN     "last_published_scan_job_id" TEXT,
ADD COLUMN     "scan_scope_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "coalesced_into_event_id" TEXT,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "job_batch_id" TEXT,
ADD COLUMN     "last_attempt_at" TIMESTAMP(3),
ADD COLUMN     "processing_started_at" TIMESTAMP(3),
ADD COLUMN     "queued_at" TIMESTAMP(3),
ADD COLUMN     "resource_id" TEXT;

-- Backfill legacy rows before tightening constraints.
UPDATE "webhook_events"
SET "idempotency_key" = COALESCE("shopify_webhook_id", CONCAT('legacy-webhook:', "id"))
WHERE "idempotency_key" IS NULL;

ALTER TABLE "webhook_events"
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "idempotency_key" SET NOT NULL,
ALTER COLUMN "status" TYPE "WebhookEventStatus" USING ("status"::text::"WebhookEventStatus"),
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "scan_job" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" "ScanJobStatus" NOT NULL DEFAULT 'RUNNING',
    "publish_status" "ScanJobPublishStatus" NOT NULL DEFAULT 'PENDING',
    "scope_flags" JSONB NOT NULL,
    "notice_version" TEXT NOT NULL,
    "successful_resource_types" JSONB NOT NULL DEFAULT '[]',
    "failed_resource_types" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "scan_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_task" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_job_id" TEXT NOT NULL,
    "resource_type" "ScanResourceType" NOT NULL,
    "status" "ScanTaskStatus" NOT NULL DEFAULT 'PENDING',
    "current_attempt_no" INTEGER NOT NULL DEFAULT 0,
    "successful_attempt_id" TEXT,
    "max_parse_attempts" INTEGER NOT NULL DEFAULT 3,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "scan_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_task_attempt" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status" "ScanTaskAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "bulk_operation_id" TEXT,
    "bulk_result_url" TEXT,
    "result_url_fetched_at" TIMESTAMP(3),
    "parsed_rows" INTEGER NOT NULL DEFAULT 0,
    "last_parse_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scan_task_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_batch" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "type" "JobBatchType" NOT NULL,
    "reservation_id" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "success" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "status" "JobBatchStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "job_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_item" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "alt_candidate_id" TEXT NOT NULL,
    "status" "JobItemStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,

    CONSTRAINT "job_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stg_product" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_attempt_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,

    CONSTRAINT "stg_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stg_media_image_product" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_attempt_id" TEXT NOT NULL,
    "media_image_id" TEXT NOT NULL,
    "parent_product_id" TEXT NOT NULL,
    "alt" TEXT,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "position_index" INTEGER,

    CONSTRAINT "stg_media_image_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stg_media_image_file" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_attempt_id" TEXT NOT NULL,
    "media_image_id" TEXT NOT NULL,
    "alt" TEXT,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,

    CONSTRAINT "stg_media_image_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stg_collection" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_attempt_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "image_alt_text" TEXT,
    "image_url" TEXT,

    CONSTRAINT "stg_collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stg_article" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_task_attempt_id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "image_alt_text" TEXT,
    "image_url" TEXT,

    CONSTRAINT "stg_article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_image_fingerprint" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_type" "ResourceImageFingerprintResourceType" NOT NULL,
    "resource_id" TEXT NOT NULL,
    "fingerprint_hash" TEXT NOT NULL,
    "last_processed_webhook_id" TEXT,
    "last_processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_image_fingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_result_target" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_job_id" TEXT NOT NULL,
    "resource_type" "ScanResourceType" NOT NULL,
    "alt_plane" "AltPlane" NOT NULL,
    "write_target_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'default',
    "display_title" TEXT,
    "display_handle" TEXT,
    "preview_url" TEXT,
    "current_alt_text" TEXT,
    "current_alt_empty" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_result_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_result_usage" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "scan_job_id" TEXT NOT NULL,
    "resource_type" "ScanResourceType" NOT NULL,
    "alt_plane" "AltPlane" NOT NULL,
    "write_target_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'default',
    "usage_type" "ImageUsageType" NOT NULL,
    "usage_id" TEXT NOT NULL,
    "title" TEXT,
    "handle" TEXT,
    "position_index" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_result_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alt_target" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "alt_plane" "AltPlane" NOT NULL,
    "write_target_id" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'default',
    "display_title" TEXT,
    "display_handle" TEXT,
    "preview_url" TEXT,
    "current_alt_text" TEXT,
    "current_alt_empty" BOOLEAN NOT NULL DEFAULT true,
    "last_published_scan_job_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "present_status" "PresentStatus" NOT NULL DEFAULT 'PRESENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alt_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_usage" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "alt_target_id" TEXT NOT NULL,
    "usage_type" "ImageUsageType" NOT NULL,
    "usage_id" TEXT NOT NULL,
    "title" TEXT,
    "handle" TEXT,
    "position_index" INTEGER,
    "last_published_scan_job_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_scan_job_id" TEXT,
    "present_status" "PresentStatus" NOT NULL DEFAULT 'PRESENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decorative_mark" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "alt_target_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "marked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmarked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decorative_mark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alt_candidate" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "alt_target_id" TEXT NOT NULL,
    "status" "AltCandidateStatus" NOT NULL DEFAULT 'MISSING',
    "missing_reason" "AltCandidateMissingReason",
    "risk_flags" JSONB NOT NULL DEFAULT '[]',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_scan_job_id" TEXT NOT NULL,
    "written_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alt_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_group_projection" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "group_type" "CandidateGroupType" NOT NULL,
    "alt_candidate_id" TEXT NOT NULL,
    "alt_target_id" TEXT NOT NULL,
    "primary_usage_type" "CandidateGroupPrimaryUsageType" NOT NULL,
    "primary_usage_id" TEXT NOT NULL,
    "primary_title" TEXT,
    "primary_handle" TEXT,
    "primary_position_index" INTEGER,
    "additional_usage_count" INTEGER NOT NULL DEFAULT 0,
    "usage_count_present" INTEGER NOT NULL DEFAULT 0,
    "impact_scope_summary" JSONB NOT NULL DEFAULT '{}',
    "last_published_scan_job_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_group_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alt_draft" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "alt_candidate_id" TEXT NOT NULL,
    "model_used" TEXT NOT NULL,
    "context_mode" "AltDraftContextMode" NOT NULL,
    "context_snapshot" JSONB NOT NULL,
    "generated_text" TEXT NOT NULL,
    "edited_text" TEXT,
    "final_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alt_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "job_batch_id" TEXT,
    "job_item_id" TEXT,
    "alt_target_id" TEXT NOT NULL,
    "alt_candidate_id" TEXT NOT NULL,
    "alt_draft_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "alt_plane" "AltPlane" NOT NULL,
    "write_target_id" TEXT NOT NULL,
    "old_alt_text" TEXT,
    "new_alt_text" TEXT NOT NULL,
    "written_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model_used" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscription" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "plan_code" "BillingPlanCode" NOT NULL,
    "billing_interval" "BillingInterval" NOT NULL,
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "external_subscription_id" TEXT,
    "external_billing_reference" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overage_pack_purchase" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "billing_subscription_id" TEXT,
    "status" "OveragePackPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "pack_code" TEXT NOT NULL,
    "granted_amount" INTEGER NOT NULL,
    "external_purchase_id" TEXT,
    "external_billing_reference" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "purchased_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overage_pack_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_bucket" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "billing_subscription_id" TEXT,
    "overage_pack_purchase_id" TEXT,
    "bucket_type" "CreditBucketType" NOT NULL,
    "status" "CreditBucketStatus" NOT NULL DEFAULT 'PENDING',
    "cycle_key" TEXT,
    "granted_amount" INTEGER NOT NULL,
    "reserved_amount" INTEGER NOT NULL DEFAULT 0,
    "consumed_amount" INTEGER NOT NULL DEFAULT 0,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "exhausted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservation" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" "CreditReservationStatus" NOT NULL DEFAULT 'PENDING',
    "requested_amount" INTEGER NOT NULL,
    "reserved_amount" INTEGER NOT NULL DEFAULT 0,
    "consumed_amount" INTEGER NOT NULL DEFAULT 0,
    "released_amount" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservation_line" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "bucket_id" TEXT NOT NULL,
    "reserved_amount" INTEGER NOT NULL,
    "consumed_amount" INTEGER NOT NULL DEFAULT 0,
    "released_amount" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_reservation_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "bucket_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "reservation_line_id" TEXT,
    "job_batch_id" TEXT,
    "type" "CreditLedgerType" NOT NULL,
    "delta_amount" INTEGER NOT NULL,
    "balance_after" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "external_billing_reference" TEXT,
    "event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_ledger" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "billing_subscription_id" TEXT,
    "overage_pack_purchase_id" TEXT,
    "entry_type" "BillingLedgerEntryType" NOT NULL,
    "status" "BillingLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "amount_cents" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'USD',
    "external_billing_reference" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_job_shop_id_idx" ON "scan_job"("shop_id");

-- CreateIndex
CREATE INDEX "scan_job_shop_id_status_started_at_idx" ON "scan_job"("shop_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "scan_job_publish_status_started_at_idx" ON "scan_job"("publish_status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "scan_task_successful_attempt_id_key" ON "scan_task"("successful_attempt_id");

-- CreateIndex
CREATE INDEX "scan_task_shop_id_idx" ON "scan_task"("shop_id");

-- CreateIndex
CREATE INDEX "scan_task_scan_job_id_status_idx" ON "scan_task"("scan_job_id", "status");

-- CreateIndex
CREATE INDEX "scan_task_shop_id_resource_type_status_idx" ON "scan_task"("shop_id", "resource_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scan_task_scan_job_id_resource_type_key" ON "scan_task"("scan_job_id", "resource_type");

-- CreateIndex
CREATE UNIQUE INDEX "scan_task_attempt_bulk_operation_id_key" ON "scan_task_attempt"("bulk_operation_id");

-- CreateIndex
CREATE INDEX "scan_task_attempt_shop_id_idx" ON "scan_task_attempt"("shop_id");

-- CreateIndex
CREATE INDEX "scan_task_attempt_scan_task_id_status_idx" ON "scan_task_attempt"("scan_task_id", "status");

-- CreateIndex
CREATE INDEX "scan_task_attempt_shop_id_status_started_at_idx" ON "scan_task_attempt"("shop_id", "status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "scan_task_attempt_scan_task_id_attempt_no_key" ON "scan_task_attempt"("scan_task_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "job_batch_reservation_id_key" ON "job_batch"("reservation_id");

-- CreateIndex
CREATE INDEX "job_batch_shop_id_idx" ON "job_batch"("shop_id");

-- CreateIndex
CREATE INDEX "job_batch_shop_id_type_started_at_idx" ON "job_batch"("shop_id", "type", "started_at");

-- CreateIndex
CREATE INDEX "job_batch_shop_id_status_started_at_idx" ON "job_batch"("shop_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "job_item_alt_candidate_id_idx" ON "job_item"("alt_candidate_id");

-- CreateIndex
CREATE INDEX "job_item_batch_id_status_idx" ON "job_item"("batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_item_batch_id_alt_candidate_id_key" ON "job_item"("batch_id", "alt_candidate_id");

-- CreateIndex
CREATE INDEX "stg_product_shop_id_idx" ON "stg_product"("shop_id");

-- CreateIndex
CREATE INDEX "stg_product_scan_task_attempt_id_idx" ON "stg_product"("scan_task_attempt_id");

-- CreateIndex
CREATE INDEX "stg_product_shop_id_product_id_idx" ON "stg_product"("shop_id", "product_id");

-- CreateIndex
CREATE INDEX "stg_product_scan_task_attempt_id_product_id_idx" ON "stg_product"("scan_task_attempt_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stg_product_shop_id_scan_task_attempt_id_product_id_key" ON "stg_product"("shop_id", "scan_task_attempt_id", "product_id");

-- CreateIndex
CREATE INDEX "stg_media_image_product_shop_id_idx" ON "stg_media_image_product"("shop_id");

-- CreateIndex
CREATE INDEX "stg_media_image_product_scan_task_attempt_id_idx" ON "stg_media_image_product"("scan_task_attempt_id");

-- CreateIndex
CREATE INDEX "stg_media_image_product_shop_id_media_image_id_idx" ON "stg_media_image_product"("shop_id", "media_image_id");

-- CreateIndex
CREATE INDEX "stg_media_image_product_shop_id_parent_product_id_idx" ON "stg_media_image_product"("shop_id", "parent_product_id");

-- CreateIndex
CREATE INDEX "stg_media_image_product_scan_task_attempt_id_parent_product_idx" ON "stg_media_image_product"("scan_task_attempt_id", "parent_product_id", "position_index");

-- CreateIndex
CREATE UNIQUE INDEX "stg_media_image_product_shop_id_scan_task_attempt_id_media__key" ON "stg_media_image_product"("shop_id", "scan_task_attempt_id", "media_image_id", "parent_product_id");

-- CreateIndex
CREATE INDEX "stg_media_image_file_shop_id_idx" ON "stg_media_image_file"("shop_id");

-- CreateIndex
CREATE INDEX "stg_media_image_file_scan_task_attempt_id_idx" ON "stg_media_image_file"("scan_task_attempt_id");

-- CreateIndex
CREATE INDEX "stg_media_image_file_shop_id_media_image_id_idx" ON "stg_media_image_file"("shop_id", "media_image_id");

-- CreateIndex
CREATE UNIQUE INDEX "stg_media_image_file_shop_id_scan_task_attempt_id_media_ima_key" ON "stg_media_image_file"("shop_id", "scan_task_attempt_id", "media_image_id");

-- CreateIndex
CREATE INDEX "stg_collection_shop_id_idx" ON "stg_collection"("shop_id");

-- CreateIndex
CREATE INDEX "stg_collection_scan_task_attempt_id_idx" ON "stg_collection"("scan_task_attempt_id");

-- CreateIndex
CREATE INDEX "stg_collection_shop_id_collection_id_idx" ON "stg_collection"("shop_id", "collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "stg_collection_shop_id_scan_task_attempt_id_collection_id_key" ON "stg_collection"("shop_id", "scan_task_attempt_id", "collection_id");

-- CreateIndex
CREATE INDEX "stg_article_shop_id_idx" ON "stg_article"("shop_id");

-- CreateIndex
CREATE INDEX "stg_article_scan_task_attempt_id_idx" ON "stg_article"("scan_task_attempt_id");

-- CreateIndex
CREATE INDEX "stg_article_shop_id_article_id_idx" ON "stg_article"("shop_id", "article_id");

-- CreateIndex
CREATE UNIQUE INDEX "stg_article_shop_id_scan_task_attempt_id_article_id_key" ON "stg_article"("shop_id", "scan_task_attempt_id", "article_id");

-- CreateIndex
CREATE INDEX "resource_image_fingerprint_shop_id_idx" ON "resource_image_fingerprint"("shop_id");

-- CreateIndex
CREATE INDEX "resource_image_fingerprint_shop_id_resource_type_idx" ON "resource_image_fingerprint"("shop_id", "resource_type");

-- CreateIndex
CREATE INDEX "resource_image_fingerprint_shop_id_resource_type_fingerprin_idx" ON "resource_image_fingerprint"("shop_id", "resource_type", "fingerprint_hash");

-- CreateIndex
CREATE INDEX "resource_image_fingerprint_last_processed_webhook_id_idx" ON "resource_image_fingerprint"("last_processed_webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_image_fingerprint_shop_id_resource_type_resource_i_key" ON "resource_image_fingerprint"("shop_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "scan_result_target_shop_id_idx" ON "scan_result_target"("shop_id");

-- CreateIndex
CREATE INDEX "scan_result_target_scan_job_id_idx" ON "scan_result_target"("scan_job_id");

-- CreateIndex
CREATE INDEX "scan_result_target_shop_id_scan_job_id_resource_type_idx" ON "scan_result_target"("shop_id", "scan_job_id", "resource_type");

-- CreateIndex
CREATE INDEX "scan_result_target_shop_id_alt_plane_locale_idx" ON "scan_result_target"("shop_id", "alt_plane", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "scan_result_target_shop_id_scan_job_id_resource_type_alt_pl_key" ON "scan_result_target"("shop_id", "scan_job_id", "resource_type", "alt_plane", "write_target_id", "locale");

-- CreateIndex
CREATE INDEX "scan_result_usage_shop_id_idx" ON "scan_result_usage"("shop_id");

-- CreateIndex
CREATE INDEX "scan_result_usage_scan_job_id_idx" ON "scan_result_usage"("scan_job_id");

-- CreateIndex
CREATE INDEX "scan_result_usage_shop_id_usage_type_idx" ON "scan_result_usage"("shop_id", "usage_type");

-- CreateIndex
CREATE INDEX "scan_result_usage_shop_id_scan_job_id_resource_type_idx" ON "scan_result_usage"("shop_id", "scan_job_id", "resource_type");

-- CreateIndex
CREATE INDEX "scan_result_usage_shop_id_scan_job_id_resource_type_alt_pla_idx" ON "scan_result_usage"("shop_id", "scan_job_id", "resource_type", "alt_plane", "write_target_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "scan_result_usage_shop_id_scan_job_id_resource_type_alt_pla_key" ON "scan_result_usage"("shop_id", "scan_job_id", "resource_type", "alt_plane", "write_target_id", "usage_type", "usage_id");

-- CreateIndex
CREATE INDEX "alt_target_shop_id_idx" ON "alt_target"("shop_id");

-- CreateIndex
CREATE INDEX "alt_target_last_published_scan_job_id_idx" ON "alt_target"("last_published_scan_job_id");

-- CreateIndex
CREATE INDEX "alt_target_shop_id_alt_plane_locale_present_status_idx" ON "alt_target"("shop_id", "alt_plane", "locale", "present_status");

-- CreateIndex
CREATE UNIQUE INDEX "alt_target_shop_id_alt_plane_write_target_id_locale_key" ON "alt_target"("shop_id", "alt_plane", "write_target_id", "locale");

-- CreateIndex
CREATE INDEX "image_usage_shop_id_idx" ON "image_usage"("shop_id");

-- CreateIndex
CREATE INDEX "image_usage_alt_target_id_idx" ON "image_usage"("alt_target_id");

-- CreateIndex
CREATE INDEX "image_usage_last_published_scan_job_id_idx" ON "image_usage"("last_published_scan_job_id");

-- CreateIndex
CREATE INDEX "image_usage_last_seen_scan_job_id_idx" ON "image_usage"("last_seen_scan_job_id");

-- CreateIndex
CREATE INDEX "image_usage_shop_id_usage_type_present_status_idx" ON "image_usage"("shop_id", "usage_type", "present_status");

-- CreateIndex
CREATE INDEX "image_usage_shop_id_usage_id_idx" ON "image_usage"("shop_id", "usage_id");

-- CreateIndex
CREATE UNIQUE INDEX "image_usage_shop_id_alt_target_id_usage_type_usage_id_key" ON "image_usage"("shop_id", "alt_target_id", "usage_type", "usage_id");

-- CreateIndex
CREATE UNIQUE INDEX "decorative_mark_alt_target_id_key" ON "decorative_mark"("alt_target_id");

-- CreateIndex
CREATE INDEX "decorative_mark_shop_id_idx" ON "decorative_mark"("shop_id");

-- CreateIndex
CREATE INDEX "decorative_mark_alt_target_id_idx" ON "decorative_mark"("alt_target_id");

-- CreateIndex
CREATE INDEX "decorative_mark_shop_id_is_active_idx" ON "decorative_mark"("shop_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "decorative_mark_shop_id_alt_target_id_key" ON "decorative_mark"("shop_id", "alt_target_id");

-- CreateIndex
CREATE UNIQUE INDEX "alt_candidate_alt_target_id_key" ON "alt_candidate"("alt_target_id");

-- CreateIndex
CREATE INDEX "alt_candidate_shop_id_idx" ON "alt_candidate"("shop_id");

-- CreateIndex
CREATE INDEX "alt_candidate_alt_target_id_idx" ON "alt_candidate"("alt_target_id");

-- CreateIndex
CREATE INDEX "alt_candidate_last_seen_scan_job_id_idx" ON "alt_candidate"("last_seen_scan_job_id");

-- CreateIndex
CREATE INDEX "alt_candidate_shop_id_status_last_seen_at_idx" ON "alt_candidate"("shop_id", "status", "last_seen_at");

-- CreateIndex
CREATE INDEX "candidate_group_projection_shop_id_idx" ON "candidate_group_projection"("shop_id");

-- CreateIndex
CREATE INDEX "candidate_group_projection_alt_candidate_id_idx" ON "candidate_group_projection"("alt_candidate_id");

-- CreateIndex
CREATE INDEX "candidate_group_projection_alt_target_id_idx" ON "candidate_group_projection"("alt_target_id");

-- CreateIndex
CREATE INDEX "candidate_group_projection_last_published_scan_job_id_idx" ON "candidate_group_projection"("last_published_scan_job_id");

-- CreateIndex
CREATE INDEX "candidate_group_projection_shop_id_group_type_idx" ON "candidate_group_projection"("shop_id", "group_type");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_group_projection_shop_id_group_type_alt_candidate_key" ON "candidate_group_projection"("shop_id", "group_type", "alt_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "alt_draft_alt_candidate_id_key" ON "alt_draft"("alt_candidate_id");

-- CreateIndex
CREATE INDEX "alt_draft_shop_id_idx" ON "alt_draft"("shop_id");

-- CreateIndex
CREATE INDEX "alt_draft_expires_at_idx" ON "alt_draft"("expires_at");

-- CreateIndex
CREATE INDEX "alt_draft_shop_id_expires_at_idx" ON "alt_draft"("shop_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_idempotency_key_key" ON "audit_log"("idempotency_key");

-- CreateIndex
CREATE INDEX "audit_log_shop_id_idx" ON "audit_log"("shop_id");

-- CreateIndex
CREATE INDEX "audit_log_job_batch_id_idx" ON "audit_log"("job_batch_id");

-- CreateIndex
CREATE INDEX "audit_log_job_item_id_idx" ON "audit_log"("job_item_id");

-- CreateIndex
CREATE INDEX "audit_log_alt_target_id_idx" ON "audit_log"("alt_target_id");

-- CreateIndex
CREATE INDEX "audit_log_alt_candidate_id_idx" ON "audit_log"("alt_candidate_id");

-- CreateIndex
CREATE INDEX "audit_log_alt_draft_id_idx" ON "audit_log"("alt_draft_id");

-- CreateIndex
CREATE INDEX "audit_log_shop_id_written_at_idx" ON "audit_log"("shop_id", "written_at");

-- CreateIndex
CREATE INDEX "audit_log_shop_id_alt_plane_written_at_idx" ON "audit_log"("shop_id", "alt_plane", "written_at");

-- CreateIndex
CREATE INDEX "audit_log_shop_id_write_target_id_written_at_idx" ON "audit_log"("shop_id", "write_target_id", "written_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_shop_id_write_target_id_alt_candidate_id_key" ON "audit_log"("shop_id", "write_target_id", "alt_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscription_external_subscription_id_key" ON "billing_subscription"("external_subscription_id");

-- CreateIndex
CREATE INDEX "billing_subscription_shop_id_idx" ON "billing_subscription"("shop_id");

-- CreateIndex
CREATE INDEX "billing_subscription_shop_id_status_current_period_end_idx" ON "billing_subscription"("shop_id", "status", "current_period_end");

-- CreateIndex
CREATE INDEX "billing_subscription_shop_id_plan_code_status_idx" ON "billing_subscription"("shop_id", "plan_code", "status");

-- CreateIndex
CREATE INDEX "billing_subscription_external_billing_reference_idx" ON "billing_subscription"("external_billing_reference");

-- CreateIndex
CREATE UNIQUE INDEX "overage_pack_purchase_external_purchase_id_key" ON "overage_pack_purchase"("external_purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "overage_pack_purchase_idempotency_key_key" ON "overage_pack_purchase"("idempotency_key");

-- CreateIndex
CREATE INDEX "overage_pack_purchase_shop_id_idx" ON "overage_pack_purchase"("shop_id");

-- CreateIndex
CREATE INDEX "overage_pack_purchase_billing_subscription_id_idx" ON "overage_pack_purchase"("billing_subscription_id");

-- CreateIndex
CREATE INDEX "overage_pack_purchase_shop_id_status_created_at_idx" ON "overage_pack_purchase"("shop_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "overage_pack_purchase_external_billing_reference_idx" ON "overage_pack_purchase"("external_billing_reference");

-- CreateIndex
CREATE INDEX "credit_bucket_shop_id_idx" ON "credit_bucket"("shop_id");

-- CreateIndex
CREATE INDEX "credit_bucket_billing_subscription_id_idx" ON "credit_bucket"("billing_subscription_id");

-- CreateIndex
CREATE INDEX "credit_bucket_overage_pack_purchase_id_idx" ON "credit_bucket"("overage_pack_purchase_id");

-- CreateIndex
CREATE INDEX "credit_bucket_shop_id_status_expires_at_idx" ON "credit_bucket"("shop_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "credit_bucket_shop_id_bucket_type_status_effective_at_idx" ON "credit_bucket"("shop_id", "bucket_type", "status", "effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_bucket_shop_id_bucket_type_cycle_key_key" ON "credit_bucket"("shop_id", "bucket_type", "cycle_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservation_idempotency_key_key" ON "credit_reservation"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_reservation_shop_id_idx" ON "credit_reservation"("shop_id");

-- CreateIndex
CREATE INDEX "credit_reservation_expires_at_idx" ON "credit_reservation"("expires_at");

-- CreateIndex
CREATE INDEX "credit_reservation_resolved_at_idx" ON "credit_reservation"("resolved_at");

-- CreateIndex
CREATE INDEX "credit_reservation_shop_id_status_created_at_idx" ON "credit_reservation"("shop_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "credit_reservation_line_shop_id_idx" ON "credit_reservation_line"("shop_id");

-- CreateIndex
CREATE INDEX "credit_reservation_line_reservation_id_idx" ON "credit_reservation_line"("reservation_id");

-- CreateIndex
CREATE INDEX "credit_reservation_line_bucket_id_idx" ON "credit_reservation_line"("bucket_id");

-- CreateIndex
CREATE INDEX "credit_reservation_line_shop_id_bucket_id_idx" ON "credit_reservation_line"("shop_id", "bucket_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_reservation_line_reservation_id_bucket_id_key" ON "credit_reservation_line"("reservation_id", "bucket_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_key" ON "credit_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_ledger_shop_id_idx" ON "credit_ledger"("shop_id");

-- CreateIndex
CREATE INDEX "credit_ledger_bucket_id_idx" ON "credit_ledger"("bucket_id");

-- CreateIndex
CREATE INDEX "credit_ledger_reservation_id_idx" ON "credit_ledger"("reservation_id");

-- CreateIndex
CREATE INDEX "credit_ledger_reservation_line_id_idx" ON "credit_ledger"("reservation_line_id");

-- CreateIndex
CREATE INDEX "credit_ledger_job_batch_id_idx" ON "credit_ledger"("job_batch_id");

-- CreateIndex
CREATE INDEX "credit_ledger_external_billing_reference_idx" ON "credit_ledger"("external_billing_reference");

-- CreateIndex
CREATE INDEX "credit_ledger_shop_id_event_at_idx" ON "credit_ledger"("shop_id", "event_at");

-- CreateIndex
CREATE INDEX "credit_ledger_shop_id_type_event_at_idx" ON "credit_ledger"("shop_id", "type", "event_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_ledger_idempotency_key_key" ON "billing_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "billing_ledger_shop_id_idx" ON "billing_ledger"("shop_id");

-- CreateIndex
CREATE INDEX "billing_ledger_billing_subscription_id_idx" ON "billing_ledger"("billing_subscription_id");

-- CreateIndex
CREATE INDEX "billing_ledger_overage_pack_purchase_id_idx" ON "billing_ledger"("overage_pack_purchase_id");

-- CreateIndex
CREATE INDEX "billing_ledger_external_billing_reference_idx" ON "billing_ledger"("external_billing_reference");

-- CreateIndex
CREATE INDEX "billing_ledger_shop_id_status_occurred_at_idx" ON "billing_ledger"("shop_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_ledger_shop_id_entry_type_occurred_at_idx" ON "billing_ledger"("shop_id", "entry_type", "occurred_at");

-- CreateIndex
CREATE INDEX "shops_last_published_scan_job_id_idx" ON "shops"("last_published_scan_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_idempotency_key_key" ON "webhook_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_events_shop_domain_topic_resource_id_received_at_idx" ON "webhook_events"("shop_domain", "topic", "resource_id", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_shop_domain_status_received_at_idx" ON "webhook_events"("shop_domain", "status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_job_batch_id_idx" ON "webhook_events"("job_batch_id");

-- CreateIndex
CREATE INDEX "webhook_events_coalesced_into_event_id_idx" ON "webhook_events"("coalesced_into_event_id");

-- CreateIndex
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- CreateIndex
CREATE INDEX "webhook_events_last_attempt_at_idx" ON "webhook_events"("last_attempt_at");

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_last_published_scan_job_id_fkey" FOREIGN KEY ("last_published_scan_job_id") REFERENCES "scan_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_job_batch_id_fkey" FOREIGN KEY ("job_batch_id") REFERENCES "job_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_coalesced_into_event_id_fkey" FOREIGN KEY ("coalesced_into_event_id") REFERENCES "webhook_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_job" ADD CONSTRAINT "scan_job_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_task" ADD CONSTRAINT "scan_task_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_task" ADD CONSTRAINT "scan_task_scan_job_id_fkey" FOREIGN KEY ("scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_task" ADD CONSTRAINT "scan_task_successful_attempt_id_fkey" FOREIGN KEY ("successful_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_task_attempt" ADD CONSTRAINT "scan_task_attempt_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_task_attempt" ADD CONSTRAINT "scan_task_attempt_scan_task_id_fkey" FOREIGN KEY ("scan_task_id") REFERENCES "scan_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_batch" ADD CONSTRAINT "job_batch_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_batch" ADD CONSTRAINT "job_batch_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_item" ADD CONSTRAINT "job_item_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "job_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_item" ADD CONSTRAINT "job_item_alt_candidate_id_fkey" FOREIGN KEY ("alt_candidate_id") REFERENCES "alt_candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_product" ADD CONSTRAINT "stg_product_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_product" ADD CONSTRAINT "stg_product_scan_task_attempt_id_fkey" FOREIGN KEY ("scan_task_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_media_image_product" ADD CONSTRAINT "stg_media_image_product_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_media_image_product" ADD CONSTRAINT "stg_media_image_product_scan_task_attempt_id_fkey" FOREIGN KEY ("scan_task_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_media_image_file" ADD CONSTRAINT "stg_media_image_file_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_media_image_file" ADD CONSTRAINT "stg_media_image_file_scan_task_attempt_id_fkey" FOREIGN KEY ("scan_task_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_collection" ADD CONSTRAINT "stg_collection_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_collection" ADD CONSTRAINT "stg_collection_scan_task_attempt_id_fkey" FOREIGN KEY ("scan_task_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_article" ADD CONSTRAINT "stg_article_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stg_article" ADD CONSTRAINT "stg_article_scan_task_attempt_id_fkey" FOREIGN KEY ("scan_task_attempt_id") REFERENCES "scan_task_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_image_fingerprint" ADD CONSTRAINT "resource_image_fingerprint_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_target" ADD CONSTRAINT "scan_result_target_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_target" ADD CONSTRAINT "scan_result_target_scan_job_id_fkey" FOREIGN KEY ("scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_target" ADD CONSTRAINT "scan_result_target_scan_job_id_resource_type_fkey" FOREIGN KEY ("scan_job_id", "resource_type") REFERENCES "scan_task"("scan_job_id", "resource_type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_usage" ADD CONSTRAINT "scan_result_usage_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_usage" ADD CONSTRAINT "scan_result_usage_scan_job_id_fkey" FOREIGN KEY ("scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_usage" ADD CONSTRAINT "scan_result_usage_scan_job_id_resource_type_fkey" FOREIGN KEY ("scan_job_id", "resource_type") REFERENCES "scan_task"("scan_job_id", "resource_type") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_result_usage" ADD CONSTRAINT "scan_result_usage_shop_id_scan_job_id_resource_type_alt_pl_fkey" FOREIGN KEY ("shop_id", "scan_job_id", "resource_type", "alt_plane", "write_target_id", "locale") REFERENCES "scan_result_target"("shop_id", "scan_job_id", "resource_type", "alt_plane", "write_target_id", "locale") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_target" ADD CONSTRAINT "alt_target_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_target" ADD CONSTRAINT "alt_target_last_published_scan_job_id_fkey" FOREIGN KEY ("last_published_scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_usage" ADD CONSTRAINT "image_usage_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_usage" ADD CONSTRAINT "image_usage_alt_target_id_fkey" FOREIGN KEY ("alt_target_id") REFERENCES "alt_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_usage" ADD CONSTRAINT "image_usage_last_published_scan_job_id_fkey" FOREIGN KEY ("last_published_scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_usage" ADD CONSTRAINT "image_usage_last_seen_scan_job_id_fkey" FOREIGN KEY ("last_seen_scan_job_id") REFERENCES "scan_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decorative_mark" ADD CONSTRAINT "decorative_mark_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decorative_mark" ADD CONSTRAINT "decorative_mark_alt_target_id_fkey" FOREIGN KEY ("alt_target_id") REFERENCES "alt_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_candidate" ADD CONSTRAINT "alt_candidate_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_candidate" ADD CONSTRAINT "alt_candidate_alt_target_id_fkey" FOREIGN KEY ("alt_target_id") REFERENCES "alt_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_candidate" ADD CONSTRAINT "alt_candidate_last_seen_scan_job_id_fkey" FOREIGN KEY ("last_seen_scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_projection" ADD CONSTRAINT "candidate_group_projection_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_projection" ADD CONSTRAINT "candidate_group_projection_alt_candidate_id_fkey" FOREIGN KEY ("alt_candidate_id") REFERENCES "alt_candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_projection" ADD CONSTRAINT "candidate_group_projection_alt_target_id_fkey" FOREIGN KEY ("alt_target_id") REFERENCES "alt_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_projection" ADD CONSTRAINT "candidate_group_projection_last_published_scan_job_id_fkey" FOREIGN KEY ("last_published_scan_job_id") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_draft" ADD CONSTRAINT "alt_draft_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alt_draft" ADD CONSTRAINT "alt_draft_alt_candidate_id_fkey" FOREIGN KEY ("alt_candidate_id") REFERENCES "alt_candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_job_batch_id_fkey" FOREIGN KEY ("job_batch_id") REFERENCES "job_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_job_item_id_fkey" FOREIGN KEY ("job_item_id") REFERENCES "job_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_alt_target_id_fkey" FOREIGN KEY ("alt_target_id") REFERENCES "alt_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_alt_candidate_id_fkey" FOREIGN KEY ("alt_candidate_id") REFERENCES "alt_candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_alt_draft_id_fkey" FOREIGN KEY ("alt_draft_id") REFERENCES "alt_draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_subscription" ADD CONSTRAINT "billing_subscription_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overage_pack_purchase" ADD CONSTRAINT "overage_pack_purchase_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overage_pack_purchase" ADD CONSTRAINT "overage_pack_purchase_billing_subscription_id_fkey" FOREIGN KEY ("billing_subscription_id") REFERENCES "billing_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_bucket" ADD CONSTRAINT "credit_bucket_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_bucket" ADD CONSTRAINT "credit_bucket_billing_subscription_id_fkey" FOREIGN KEY ("billing_subscription_id") REFERENCES "billing_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_bucket" ADD CONSTRAINT "credit_bucket_overage_pack_purchase_id_fkey" FOREIGN KEY ("overage_pack_purchase_id") REFERENCES "overage_pack_purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation" ADD CONSTRAINT "credit_reservation_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_line" ADD CONSTRAINT "credit_reservation_line_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_line" ADD CONSTRAINT "credit_reservation_line_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservation_line" ADD CONSTRAINT "credit_reservation_line_bucket_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "credit_bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_bucket_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "credit_bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "credit_reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reservation_line_id_fkey" FOREIGN KEY ("reservation_line_id") REFERENCES "credit_reservation_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_job_batch_id_fkey" FOREIGN KEY ("job_batch_id") REFERENCES "job_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_billing_subscription_id_fkey" FOREIGN KEY ("billing_subscription_id") REFERENCES "billing_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_ledger" ADD CONSTRAINT "billing_ledger_overage_pack_purchase_id_fkey" FOREIGN KEY ("overage_pack_purchase_id") REFERENCES "overage_pack_purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
