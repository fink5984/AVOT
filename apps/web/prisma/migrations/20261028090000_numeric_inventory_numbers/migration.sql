-- AVOT Studio — numeric-only inventory numbers (10000001, 10000002 …) with full backward compatibility.
--
-- WHAT IT DOES (one transaction; abort leaves the database untouched):
--   1. widens InventoryItem.serial and Organization.inventorySerialSeq to BIGINT (no overflow ceiling);
--   2. creates InventoryNumberAlias — the previous numbers stay valid forever: scanning the printed
--      "ITM-000035" finds the same book as "10000035";
--   3. converts every existing book: inventoryNumber = 10000000 + serial (ITM-000035 → 10000035). When the book's
--      barcode was its own inventory number it follows (so new labels carry only the number); an external barcode
--      registered on a book is left exactly as it was;
--   4. never touches ids (UUID), photos, lots, catalogs, locations or movements.
--
-- SAFETY: refuses to run when a converted number would collide with ANY existing barcode of another book.
-- Run scripts/numbering-report.ts (read-only) first, take a backup, review the mapping, and only then deploy.
-- Reverse: prisma/rollback/20261028090000_numeric_inventory_numbers.down.sql

BEGIN;

ALTER TABLE "InventoryItem" ALTER COLUMN "serial" TYPE BIGINT;
ALTER TABLE "Organization" ALTER COLUMN "inventorySerialSeq" TYPE BIGINT;

CREATE TABLE "InventoryNumberAlias" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "inventoryItemId" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  -- LEGACY_ITM = the "ITM-000035" number printed on tags before the numeric scheme
  "kind" TEXT NOT NULL DEFAULT 'LEGACY_ITM',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryNumberAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryNumberAlias_organizationId_alias_key" ON "InventoryNumberAlias"("organizationId", "alias");
CREATE INDEX "InventoryNumberAlias_inventoryItemId_idx" ON "InventoryNumberAlias"("inventoryItemId");
ALTER TABLE "InventoryNumberAlias" ADD CONSTRAINT "InventoryNumberAlias_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryNumberAlias" ADD CONSTRAINT "InventoryNumberAlias_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE clash TEXT;
BEGIN
  SELECT string_agg(a."inventoryNumber" || ' ↔ ' || b."inventoryNumber", ', ') INTO clash
  FROM "InventoryItem" a
  JOIN "InventoryItem" b ON b."organizationId" = a."organizationId" AND b.id <> a.id AND b."barcode" = (10000000 + a."serial")::text
  WHERE a."inventoryNumber" !~ '^[0-9]+$';
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'numeric inventory numbers would collide with existing barcodes: %', clash;
  END IF;
END $$;

-- the old numbers become aliases (idempotent: only books that still carry a non-numeric number)
INSERT INTO "InventoryNumberAlias" ("id", "organizationId", "inventoryItemId", "alias", "kind")
SELECT gen_random_uuid(), "organizationId", "id", "inventoryNumber", 'LEGACY_ITM'
FROM "InventoryItem"
WHERE "inventoryNumber" !~ '^[0-9]+$'
ON CONFLICT ("organizationId", "alias") DO NOTHING;

-- barcode first (it is compared with the OLD number), then the number itself
UPDATE "InventoryItem" SET "barcode" = (10000000 + "serial")::text
WHERE "inventoryNumber" !~ '^[0-9]+$' AND "barcode" = "inventoryNumber";
UPDATE "InventoryItem" SET "inventoryNumber" = (10000000 + "serial")::text
WHERE "inventoryNumber" !~ '^[0-9]+$';

COMMIT;
