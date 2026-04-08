-- Alter shops.scan_scope_flags from legacy bitmask INTEGER to canonical JSONB
-- object state, then add the first Phase 2 tables.

ALTER TABLE "shops"
    ALTER COLUMN "scan_scope_flags" DROP DEFAULT;

ALTER TABLE "shops"
    ALTER COLUMN "scan_scope_flags" TYPE JSONB
    USING jsonb_build_object(
        'PRODUCT_MEDIA', ("scan_scope_flags" & 1) <> 0,
        'FILES', ("scan_scope_flags" & 2) <> 0,
        'COLLECTION_IMAGE', ("scan_scope_flags" & 4) <> 0,
        'ARTICLE_IMAGE', ("scan_scope_flags" & 8) <> 0
    );

ALTER TABLE "shops"
    ALTER COLUMN "scan_scope_flags" SET DEFAULT '{"PRODUCT_MEDIA": true, "FILES": true, "COLLECTION_IMAGE": true, "ARTICLE_IMAGE": true}'::jsonb;

ALTER TABLE "shops"
    ADD COLUMN "last_published_scope_flags" JSONB;

CREATE TABLE "scan_notice_ack" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "notice_version" TEXT NOT NULL,
    "scope_flags_snapshot" JSONB NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_notice_ack_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_operation_lock" (
    "shop_id" TEXT NOT NULL,
    "lock_type" TEXT NOT NULL,
    "batch_id" TEXT,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "shop_operation_lock_pkey" PRIMARY KEY ("shop_id")
);

CREATE UNIQUE INDEX "scan_notice_ack_shop_id_notice_version_key"
    ON "scan_notice_ack"("shop_id", "notice_version");

CREATE INDEX "scan_notice_ack_notice_version_idx"
    ON "scan_notice_ack"("notice_version");

CREATE INDEX "shop_operation_lock_status_expires_at_idx"
    ON "shop_operation_lock"("status", "expires_at");

CREATE INDEX "shop_operation_lock_lock_type_status_idx"
    ON "shop_operation_lock"("lock_type", "status");

ALTER TABLE "scan_notice_ack"
    ADD CONSTRAINT "scan_notice_ack_shop_id_fkey"
    FOREIGN KEY ("shop_id")
    REFERENCES "shops"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "shop_operation_lock"
    ADD CONSTRAINT "shop_operation_lock_shop_id_fkey"
    FOREIGN KEY ("shop_id")
    REFERENCES "shops"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
