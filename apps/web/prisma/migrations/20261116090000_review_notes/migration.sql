-- "הערות לבדיקה": internal, unverified notes on a book, shared by inventory and every catalog. Additive only:
-- a new enum and a new table; no existing row or column changes.
CREATE TYPE "ReviewNoteStatus" AS ENUM ('OPEN', 'VERIFIED', 'NOT_VERIFIED');

CREATE TABLE "ItemReviewNote" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inventoryItemId" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "status" "ReviewNoteStatus" NOT NULL DEFAULT 'OPEN',
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedById" UUID,
  "resolvedAt" TIMESTAMP(3),
  "conclusion" TEXT,
  CONSTRAINT "ItemReviewNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ItemReviewNote_inventoryItemId_createdAt_idx" ON "ItemReviewNote"("inventoryItemId", "createdAt");
CREATE INDEX "ItemReviewNote_organizationId_status_idx" ON "ItemReviewNote"("organizationId", "status");

ALTER TABLE "ItemReviewNote" ADD CONSTRAINT "ItemReviewNote_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
