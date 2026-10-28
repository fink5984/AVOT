-- AVOT Studio — shelf-only locations: warehouse → column → shelf. There are no cells.
--
-- WHAT IT DOES (one transaction; abort leaves the database untouched):
--   1. adds Shelf.deletedAt / WarehouseZone.deletedAt (taking a shelf or column out of the active structure while
--      keeping its history) and StorageLocation.mergedIntoId;
--   2. creates StorageLocationAlias — printed codes such as "LOC-W1-C4-04-01" keep finding the shelf forever;
--   3. every shelf ends up with ONE active location. A shelf that had several cells keeps its first cell as the shelf's
--      location; books on the other cells move to it (one MANUAL movement each, so the history shows it); the other
--      cell rows stay as inactive rows pointing at it (mergedIntoId) so old movements / counts / scans remain valid;
--   4. the shelf location's code loses its cell suffix (LOC-W1-C4-04-01 → LOC-W1-C4-04); the old code becomes an alias.
--   Nothing is deleted: no books, no locations, no movements, no counts, no scans.
--
-- SAFETY: refuses to run when an OPEN stock count or an open pick task points at a cell that would be merged, or when a
-- new code would collide with an existing one. Run scripts/locations-report.ts (read-only) first, take a backup,
-- review, and only then deploy. Reverse: prisma/rollback/20261029090000_shelf_locations.down.sql

BEGIN;

ALTER TABLE "Shelf" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "WarehouseZone" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "StorageLocation" ADD COLUMN "mergedIntoId" UUID;

CREATE TABLE "StorageLocationAlias" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  -- NULL = the shelf was deleted: the code stays reserved so it is never reused for another shelf
  "locationId" UUID,
  "alias" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorageLocationAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StorageLocationAlias_organizationId_alias_key" ON "StorageLocationAlias"("organizationId", "alias");
CREATE INDEX "StorageLocationAlias_locationId_idx" ON "StorageLocationAlias"("locationId");
ALTER TABLE "StorageLocationAlias" ADD CONSTRAINT "StorageLocationAlias_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StorageLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- the location a shelf keeps: cell "01", else the first by sort key
CREATE TEMP TABLE _shelf_primary ON COMMIT DROP AS
  SELECT DISTINCT ON ("shelfId") id AS primary_id, "shelfId"
  FROM "StorageLocation"
  ORDER BY "shelfId", (cell <> '01'), "sortKey", "createdAt";

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT l.code, ', ') INTO bad
  FROM "StorageLocation" l JOIN _shelf_primary p ON p."shelfId" = l."shelfId" AND l.id <> p.primary_id
  JOIN "StockCountLocation" c ON c."locationId" = l.id JOIN "StockCountSession" s ON s.id = c."sessionId"
  WHERE s.status = 'OPEN';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'open stock count on a cell that would be merged: %', bad; END IF;

  SELECT string_agg(DISTINCT l.code, ', ') INTO bad
  FROM "StorageLocation" l JOIN _shelf_primary p ON p."shelfId" = l."shelfId" AND l.id <> p.primary_id
  JOIN "PickTask" t ON t."sourceLocationId" = l.id
  WHERE t.status IN ('OPEN', 'PICKED', 'PACKED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'open pick task on a cell that would be merged: %', bad; END IF;

  SELECT string_agg(l.code || ' -> ' || regexp_replace(l.code, '-[^-]+$', ''), ', ') INTO bad
  FROM "StorageLocation" l JOIN _shelf_primary p ON p.primary_id = l.id
  WHERE EXISTS (SELECT 1 FROM "StorageLocation" o WHERE o."organizationId" = l."organizationId" AND o.id <> l.id AND o.code = regexp_replace(l.code, '-[^-]+$', ''));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'new shelf code already in use: %', bad; END IF;
END $$;

-- 1. books on merged cells move to the shelf's location — each move is a movement row
INSERT INTO "InventoryLocationMovement" ("id", "organizationId", "inventoryItemId", "fromLocationId", "toLocationId", "kind", "occurredAt", "note")
SELECT gen_random_uuid(), i."organizationId", i.id, i."currentLocationId", p.primary_id, 'MANUAL', now(), 'איחוד תאים למדף (הסבת מבנה המחסן)'
FROM "InventoryItem" i
JOIN "StorageLocation" l ON l.id = i."currentLocationId"
JOIN _shelf_primary p ON p."shelfId" = l."shelfId" AND l.id <> p.primary_id;

UPDATE "InventoryItem" i SET "currentLocationId" = p.primary_id, "locationUpdatedAt" = now()
FROM "StorageLocation" l JOIN _shelf_primary p ON p."shelfId" = l."shelfId" AND l.id <> p.primary_id
WHERE i."currentLocationId" = l.id;

-- 2. every old code (the shelf's own and the merged cells') stays valid as an alias of the shelf's location
INSERT INTO "StorageLocationAlias" ("id", "organizationId", "locationId", "alias")
SELECT gen_random_uuid(), l."organizationId", p.primary_id, l.code
FROM "StorageLocation" l JOIN _shelf_primary p ON p."shelfId" = l."shelfId";

-- 3. merged cells: kept for history, inactive, pointing at the shelf's location; the suffix keeps the code unique
UPDATE "StorageLocation" l SET "active" = false, "mergedIntoId" = p.primary_id, "code" = l.code || '~merged'
FROM _shelf_primary p WHERE p."shelfId" = l."shelfId" AND l.id <> p.primary_id;

-- 4. the shelf's own location: no cell in the code
UPDATE "StorageLocation" l SET "code" = regexp_replace(l.code, '-[^-]+$', '')
FROM _shelf_primary p WHERE p.primary_id = l.id;

ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
