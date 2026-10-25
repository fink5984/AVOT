-- Reverse of migration 20261025100000_inventory_phase2.
--
-- Use only if Phase 2 must be withdrawn. Prefer restoring the pre-migration
-- backup (scripts/db-backup.ps1) when no real work was done after migrating.
--
-- The script REFUSES to run (and changes nothing) when data created after the
-- migration cannot be represented in the old schema:
--   * photos taken from inventory (no lot)          → assign the book to a catalog first
--   * catalogs with the same number in both houses  → renumber one of them
--   * books with more than one lot (re-assignments)  → old schema had 1 book = 1 lot; the
--     lots survive, but their photos stay attached to the lot they were shot for
--   * users with the WAREHOUSE role                  → change their role first
-- Run:  psql "<url>" -v ON_ERROR_STOP=1 -f prisma/rollback/20261025100000_inventory_phase2.down.sql
-- then: delete the migration folder from prisma/migrations and redeploy the previous app version.

BEGIN;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "PhotoAsset" WHERE "lotId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'rollback refused: % photos are not attached to a lot (shot from inventory)', n; END IF;
  SELECT count(*) INTO n FROM (SELECT "organizationId", "number" FROM "Catalog" GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'rollback refused: % catalog numbers exist in both auction houses', n; END IF;
  SELECT count(*) INTO n FROM "User" WHERE "role" = 'WAREHOUSE';
  IF n > 0 THEN RAISE EXCEPTION 'rollback refused: % users have the WAREHOUSE role', n; END IF;
  SELECT count(*) INTO n FROM "CaptureSession" WHERE "lotId" IS NULL OR "catalogId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'rollback refused: % capture sessions have no lot', n; END IF;
END $$;

-- photo-ownership derived values go back onto the lots
UPDATE "Lot" l SET "photoCount" = (SELECT count(*) FROM "PhotoAsset" p WHERE p."lotId" = l."id" AND p."deletedAt" IS NULL);

DROP TABLE "PickTask", "StockCountEntry", "StockCountLocation", "StockCountSession", "BarcodeScanEvent",
  "InventoryLocationMovement", "LotDisplayAsset", "LotDescriptionVersion", "InventoryAnalysis",
  "InventoryStatusEvent", "InventoryCategoryNote", "UserHouseAccess" CASCADE;

ALTER TABLE "PhotoAsset" DROP CONSTRAINT "PhotoAsset_inventoryItemId_fkey";
ALTER TABLE "PhotoAsset" DROP CONSTRAINT "PhotoAsset_lotId_fkey";
ALTER TABLE "PhotoAsset" DROP CONSTRAINT "PhotoAsset_catalogId_fkey";
DROP INDEX IF EXISTS "PhotoAsset_inventoryItemId_category_deletedAt_sortOrder_idx";
ALTER TABLE "PhotoAsset" DROP COLUMN "inventoryItemId";
ALTER TABLE "PhotoAsset" ALTER COLUMN "lotId" SET NOT NULL, ALTER COLUMN "catalogId" SET NOT NULL;
ALTER TABLE "PhotoAsset" ADD CONSTRAINT "PhotoAsset_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PhotoAsset" ADD CONSTRAINT "PhotoAsset_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CaptureSession" DROP COLUMN "inventoryItemId";
ALTER TABLE "CaptureSession" ALTER COLUMN "lotId" SET NOT NULL, ALTER COLUMN "catalogId" SET NOT NULL;

-- the migration's own bookkeeping rows; audit rows written by users after migrating are kept
DELETE FROM "AuditLog" WHERE "action" = 'inventory.migrated';
ALTER TABLE "AuditLog" DROP COLUMN "inventoryItemId";

ALTER TABLE "Lot" DROP CONSTRAINT "Lot_inventoryItemId_fkey";
DROP INDEX IF EXISTS "Lot_inventoryItemId_active_key";
DROP INDEX IF EXISTS "Lot_inventoryItemId_idx";
ALTER TABLE "Lot" DROP COLUMN "inventoryItemId", DROP COLUMN "assignmentStatus", DROP COLUMN "commercialStatus",
  DROP COLUMN "assignedAt", DROP COLUMN "assignedById", DROP COLUMN "endedAt", DROP COLUMN "endReason",
  DROP COLUMN "description", DROP COLUMN "pageRef";

DROP TABLE "InventoryItem" CASCADE;
DROP TABLE "StorageLocation", "Shelf", "WarehouseZone", "Warehouse" CASCADE;

ALTER TABLE "Catalog" DROP CONSTRAINT "Catalog_auctionHouseId_fkey";
DROP INDEX "Catalog_auctionHouseId_number_key";
ALTER TABLE "Catalog" DROP COLUMN "auctionHouseId";
CREATE UNIQUE INDEX "Catalog_organizationId_number_key" ON "Catalog"("organizationId", "number");
DROP TABLE "AuctionHouse";

ALTER TABLE "Organization" DROP COLUMN "inventorySerialSeq";

DROP TYPE "PickStatus", "StockCountStatus", "ScanResult", "ScanMode", "MovementKind", "DescriptionSource",
  "StatusDimension", "LotAssignmentStatus", "BookSize", "CommercialStatus", "PhysicalStatus";
-- Role.WAREHOUSE stays in the enum: PostgreSQL cannot drop an enum value, and no row uses it (checked above).

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025100000_inventory_phase2';

COMMIT;
