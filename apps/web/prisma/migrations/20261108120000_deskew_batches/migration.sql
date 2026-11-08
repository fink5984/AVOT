-- AVOT Studio — straightening (auto deskew) of existing photos, run by scripts/deskew-batch.ts.
-- Additive only: two new enums, two new tables, nothing existing is touched. Photos keep working unchanged;
-- the tables stay empty until someone starts a batch.

-- CreateEnum
CREATE TYPE "DeskewBatchStatus" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "DeskewItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'APPLIED', 'SKIPPED', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "DeskewBatch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "status" "DeskewBatchStatus" NOT NULL DEFAULT 'RUNNING',
    "algoVersion" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),

    CONSTRAINT "DeskewBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskewBatchItem" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "status" "DeskewItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT,
    "tilt" DOUBLE PRECISION,
    "angle" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "skipReason" TEXT,
    "changed" BOOLEAN NOT NULL DEFAULT false,
    "ms" INTEGER,
    "error" TEXT,
    "previous" JSONB,
    "newKeys" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeskewBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeskewBatch_organizationId_createdAt_idx" ON "DeskewBatch"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "DeskewBatchItem_batchId_status_idx" ON "DeskewBatchItem"("batchId", "status");

-- CreateIndex
CREATE INDEX "DeskewBatchItem_assetId_idx" ON "DeskewBatchItem"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "DeskewBatchItem_batchId_assetId_key" ON "DeskewBatchItem"("batchId", "assetId");

-- AddForeignKey
ALTER TABLE "DeskewBatch" ADD CONSTRAINT "DeskewBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeskewBatchItem" ADD CONSTRAINT "DeskewBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeskewBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
