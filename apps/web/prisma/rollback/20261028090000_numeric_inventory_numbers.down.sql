-- Reverse of 20261028090000_numeric_inventory_numbers.
-- Every book gets its legacy "ITM-" number back: from its alias when it has one, otherwise (books created after the
-- migration) the number ITM-<serial padded to 6>. Barcodes that equal the numeric number follow. The BIGINT columns
-- stay BIGINT (harmless). Photos / lots / catalogs / locations are not touched.
BEGIN;

UPDATE "InventoryItem" i
SET "barcode" = COALESCE((SELECT a."alias" FROM "InventoryNumberAlias" a WHERE a."inventoryItemId" = i.id AND a."kind" = 'LEGACY_ITM' ORDER BY a."createdAt" LIMIT 1),
                         'ITM-' || lpad(i."serial"::text, 6, '0'))
WHERE i."inventoryNumber" ~ '^[0-9]+$' AND i."barcode" = i."inventoryNumber";

UPDATE "InventoryItem" i
SET "inventoryNumber" = COALESCE((SELECT a."alias" FROM "InventoryNumberAlias" a WHERE a."inventoryItemId" = i.id AND a."kind" = 'LEGACY_ITM' ORDER BY a."createdAt" LIMIT 1),
                                 'ITM-' || lpad(i."serial"::text, 6, '0'))
WHERE i."inventoryNumber" ~ '^[0-9]+$';

DROP TABLE IF EXISTS "InventoryNumberAlias";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261028090000_numeric_inventory_numbers';
COMMIT;
