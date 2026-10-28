-- Reverse of 20261029090000_shelf_locations. Run against the database BEFORE removing the migration folder,
-- then `prisma migrate resolve --rolled-back 20261029090000_shelf_locations`.
-- Restores the old cell codes from the aliases and re-activates the merged cell rows. Books that were moved from a
-- merged cell onto the shelf's location are NOT moved back (their movement rows say where they came from).
BEGIN;

UPDATE "StorageLocation" l SET "code" = regexp_replace(l.code, '~merged$', '')
WHERE l."mergedIntoId" IS NOT NULL;

UPDATE "StorageLocation" l SET "code" = a.alias
FROM "StorageLocationAlias" a
WHERE a."locationId" = l.id AND l."mergedIntoId" IS NULL AND a.alias = l.code || '-' || l.cell;

UPDATE "StorageLocation" SET "active" = true WHERE "mergedIntoId" IS NOT NULL;
ALTER TABLE "StorageLocation" DROP CONSTRAINT "StorageLocation_mergedIntoId_fkey";
ALTER TABLE "StorageLocation" DROP COLUMN "mergedIntoId";
DROP TABLE "StorageLocationAlias";
ALTER TABLE "WarehouseZone" DROP COLUMN "deletedAt";
ALTER TABLE "Shelf" DROP COLUMN "deletedAt";

COMMIT;
