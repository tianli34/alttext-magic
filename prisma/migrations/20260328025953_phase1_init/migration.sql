-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN,
    "locale" TEXT,
    "collaborator" BOOLEAN,
    "emailVerified" BOOLEAN,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "access_token_nonce" TEXT NOT NULL,
    "access_token_tag" TEXT NOT NULL,
    "scopes" TEXT,
    "current_plan" TEXT NOT NULL DEFAULT 'FREE',
    "scan_scope_flags" INTEGER NOT NULL DEFAULT 15,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopify_webhook_id" TEXT NOT NULL,
    "api_version" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_domain_key" ON "shops"("shop_domain");

-- CreateIndex
CREATE INDEX "shops_current_plan_idx" ON "shops"("current_plan");

-- CreateIndex
CREATE INDEX "shops_uninstalled_at_idx" ON "shops"("uninstalled_at");

-- CreateIndex
CREATE INDEX "shops_uninstalled_at_current_plan_idx" ON "shops"("uninstalled_at", "current_plan");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_shopify_webhook_id_key" ON "webhook_events"("shopify_webhook_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_shop_domain_topic_received_at_idx" ON "webhook_events"("shop_domain", "topic", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shop_domain_fkey" FOREIGN KEY ("shop_domain") REFERENCES "shops"("shop_domain") ON DELETE CASCADE ON UPDATE CASCADE;
