-- Reverse of 20261110090000_combined_lots.
-- SAFE ONLY while no combined lot exists (every lot has exactly one present member): the old code knows one book per
-- lot (Lot.inventoryItemId) and would silently ignore the other books of a combined lot. Dissolve every combined lot
-- in the application first ("פירוק הלוט"); this guard refuses otherwise. Merged-away lots (mergedIntoLotId) are
-- ended history rows and stay as ordinary ended lots.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LotMember" WHERE "removedAt" IS NULL GROUP BY "lotId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'combined lots still exist: dissolve them before rolling back';
  END IF;
END $$;

DROP TABLE "LotAiRun";
DROP TABLE "LotCompositionEvent";
DROP TABLE "LotMember";
ALTER TABLE "Lot" DROP CONSTRAINT "Lot_mergedIntoLotId_fkey";
DROP INDEX "Lot_mergedIntoLotId_idx";
ALTER TABLE "Lot" DROP COLUMN "aiDescriptionRunId", DROP COLUMN "compositionVersion", DROP COLUMN "descriptionNeedsUpdate", DROP COLUMN "mergedIntoLotId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110090000_combined_lots';
