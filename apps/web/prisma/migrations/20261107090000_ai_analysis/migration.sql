-- AVOT Studio — AI analysis of items, "מצב פרטי הפריט" (human review) and AI run history.
-- Additive only: new enums, new columns with defaults / NULL, and new indexes. No existing value is changed:
-- every existing book starts as itemType UNKNOWN, reviewStatus NOT_STARTED, aiStatus NOT_RUN.
-- InventoryAnalysis (prepared earlier for this module, unused so far) gains the run columns; its "result" becomes
-- nullable because a run exists before it has a result. Rows that may already exist are marked COMPLETED.

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('UNKNOWN', 'BOOK', 'MANUSCRIPT', 'LETTER', 'DOCUMENT', 'POSTER', 'PERIODICAL', 'PHOTOGRAPH', 'MAP', 'JUDAICA', 'ARTWORK', 'EPHEMERA', 'OTHER');

-- CreateEnum
CREATE TYPE "ItemReviewStatus" AS ENUM ('NOT_STARTED', 'PENDING_REVIEW', 'IN_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('NOT_RUN', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "StatusDimension" ADD VALUE 'REVIEW';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'AI_ANALYZE';

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "aiCompletedAt" TIMESTAMP(3),
ADD COLUMN     "aiError" TEXT,
ADD COLUMN     "aiRunId" UUID,
ADD COLUMN     "aiStatus" "AiAnalysisStatus" NOT NULL DEFAULT 'NOT_RUN',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "catalogDescription" TEXT,
ADD COLUMN     "catalogDescriptionSource" "DescriptionSource",
ADD COLUMN     "catalogHeadline" TEXT,
ADD COLUMN     "detailsVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "edition" TEXT,
ADD COLUMN     "extent" TEXT,
ADD COLUMN     "itemType" "ItemType" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "reviewChangedAt" TIMESTAMP(3),
ADD COLUMN     "reviewChangedById" UUID,
ADD COLUMN     "reviewStatus" "ItemReviewStatus" NOT NULL DEFAULT 'NOT_STARTED';

-- AlterTable
ALTER TABLE "InventoryAnalysis" ADD COLUMN     "applied" JSONB,
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "baseValues" JSONB,
ADD COLUMN     "cachedInputTokens" INTEGER,
ADD COLUMN     "costEstimated" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "costUsd" DECIMAL(12,6),
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "examplesCount" INTEGER,
ADD COLUMN     "examplesHash" TEXT,
ADD COLUMN     "examplesVersion" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "isReanalysis" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jobId" UUID,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "reasoningTokens" INTEGER,
ADD COLUMN     "requestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requestKey" UUID,
ADD COLUMN     "restoredAt" TIMESTAMP(3),
ADD COLUMN     "restoredById" UUID,
ADD COLUMN     "reviewOutcome" JSONB,
ADD COLUMN     "snapshot" JSONB,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" "AiAnalysisStatus" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "usage" JSONB,
ALTER COLUMN "result" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_reviewStatus_idx" ON "InventoryItem"("organizationId", "reviewStatus");

-- CreateIndex
CREATE INDEX "InventoryAnalysis_organizationId_createdAt_idx" ON "InventoryAnalysis"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAnalysis_organizationId_requestKey_key" ON "InventoryAnalysis"("organizationId", "requestKey");


-- rows written before this migration (if any) are finished analyses, not queued work
UPDATE "InventoryAnalysis" SET "status" = 'COMPLETED' WHERE "result" IS NOT NULL;

-- one queued / running AI run per item: a second click, a second tab or a retried request can never start a parallel run
CREATE UNIQUE INDEX "InventoryAnalysis_item_active_key" ON "InventoryAnalysis"("inventoryItemId") WHERE "status" IN ('QUEUED', 'RUNNING');
