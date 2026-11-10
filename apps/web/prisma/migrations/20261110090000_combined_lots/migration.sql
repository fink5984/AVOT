-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "aiDescriptionRunId" UUID,
ADD COLUMN     "compositionVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "descriptionNeedsUpdate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mergedIntoLotId" UUID;

-- CreateTable
CREATE TABLE "LotMember" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "originLotId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" UUID,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    "removalReason" TEXT,

    CONSTRAINT "LotMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotCompositionEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "itemIds" JSONB NOT NULL,
    "userId" UUID,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotCompositionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotAiRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL DEFAULT 'RUNNING',
    "compositionVersion" INTEGER NOT NULL,
    "members" JSONB NOT NULL,
    "input" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "settingsVersion" INTEGER,
    "promptVersion" TEXT,
    "examplesVersion" TEXT,
    "examplesHash" TEXT,
    "proposedTitle" TEXT,
    "proposedShortDescription" TEXT,
    "proposedDescription" TEXT,
    "result" JSONB,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DECIMAL(12,6),
    "costEstimated" BOOLEAN NOT NULL DEFAULT true,
    "usage" JSONB,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "appliedById" UUID,
    "appliedVersion" INTEGER,
    "discardedAt" TIMESTAMP(3),

    CONSTRAINT "LotAiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LotMember_lotId_removedAt_idx" ON "LotMember"("lotId", "removedAt");

-- CreateIndex
CREATE INDEX "LotMember_inventoryItemId_isActive_idx" ON "LotMember"("inventoryItemId", "isActive");

-- CreateIndex
CREATE INDEX "LotMember_organizationId_idx" ON "LotMember"("organizationId");

-- CreateIndex
CREATE INDEX "LotCompositionEvent_lotId_createdAt_idx" ON "LotCompositionEvent"("lotId", "createdAt");

-- CreateIndex
CREATE INDEX "LotAiRun_lotId_createdAt_idx" ON "LotAiRun"("lotId", "createdAt");

-- CreateIndex
CREATE INDEX "LotAiRun_organizationId_createdAt_idx" ON "LotAiRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Lot_mergedIntoLotId_idx" ON "Lot"("mergedIntoLotId");

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_mergedIntoLotId_fkey" FOREIGN KEY ("mergedIntoLotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotMember" ADD CONSTRAINT "LotMember_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotMember" ADD CONSTRAINT "LotMember_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotCompositionEvent" ADD CONSTRAINT "LotCompositionEvent_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotAiRun" ADD CONSTRAINT "LotAiRun_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────── combined lots: data + constraints ─────────────────────────
-- Every existing lot gets exactly one member: its own book. Lot ids, lot numbers, assignment history, photos and
-- description versions are untouched (nothing is updated or deleted in "Lot"); a lot that is not ACTIVE gets an
-- inactive (but still present) member, so its history stays complete.
INSERT INTO "LotMember" ("id", "organizationId", "lotId", "inventoryItemId", "sortOrder", "originLotId", "isActive", "addedAt", "addedById")
SELECT gen_random_uuid(), l."organizationId", l."id", l."inventoryItemId", 1, NULL, (l."assignmentStatus" = 'ACTIVE'), l."assignedAt", l."assignedById"
FROM "Lot" l;

-- a book is present in at most one ACTIVE lot (the lot-level index "Lot_inventoryItemId_active_key" stays as a second guard)
CREATE UNIQUE INDEX "LotMember_item_active_key" ON "LotMember"("inventoryItemId") WHERE "isActive" AND "removedAt" IS NULL;

-- a book is present at most once in one lot
CREATE UNIQUE INDEX "LotMember_lot_item_present_key" ON "LotMember"("lotId", "inventoryItemId") WHERE "removedAt" IS NULL;
