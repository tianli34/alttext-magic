-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "alt_draft" ADD COLUMN     "processing_status" TEXT,
ADD COLUMN     "raw_text" TEXT;
