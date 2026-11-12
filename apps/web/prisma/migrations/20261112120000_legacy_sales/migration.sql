-- A sale from the old system (before AVOT) hangs on the book itself: no lot, no catalog, no order; price and buyer unknown.

ALTER TABLE "Purchase" ADD COLUMN "inventoryItemId" UUID;
ALTER TABLE "Purchase" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "Purchase" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "Purchase" ALTER COLUMN "catalogId" DROP NOT NULL;
ALTER TABLE "Purchase" ALTER COLUMN "lotId" DROP NOT NULL;
ALTER TABLE "Purchase" ALTER COLUMN "hammerPrice" DROP NOT NULL;

ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Purchase_inventoryItemId_idx" ON "Purchase"("inventoryItemId");

-- every purchase belongs to a lot or to a book; an ordinary one has a price and a buyer
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_target_check" CHECK ("lotId" IS NOT NULL OR "inventoryItemId" IS NOT NULL);
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_ordinary_check" CHECK ("source" = 'LEGACY_MANUAL' OR ("lotId" IS NOT NULL AND "customerId" IS NOT NULL AND "hammerPrice" IS NOT NULL AND "orderId" IS NOT NULL));
-- at most one active legacy sale per book (a double click or two requests cannot create two)
CREATE UNIQUE INDEX "Purchase_one_active_legacy_per_item" ON "Purchase"("inventoryItemId") WHERE "status" = 'ACTIVE' AND "lotId" IS NULL;
