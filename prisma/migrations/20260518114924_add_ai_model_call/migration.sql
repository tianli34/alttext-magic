-- CreateTable
CREATE TABLE "ai_model_call" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "candidate_id" TEXT,
    "batch_id" TEXT,
    "model_name" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "failure_origin" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_model_call_model_name_idx" ON "ai_model_call"("model_name");

-- CreateIndex
CREATE INDEX "ai_model_call_shop_id_idx" ON "ai_model_call"("shop_id");
