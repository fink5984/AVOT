-- A shelf can be renamed (display name only). The code - and so the printed barcode - never changes. Additive.
ALTER TABLE "Shelf" ADD COLUMN "name" TEXT;

-- two live shelves of one column never share a display name (case-insensitive); the service checks the same rule first, this closes the race
CREATE UNIQUE INDEX "Shelf_zone_name_key" ON "Shelf"("zoneId", lower("name")) WHERE "name" IS NOT NULL AND "deletedAt" IS NULL;
