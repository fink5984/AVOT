-- AVOT Studio — Phase 2: central inventory, two auction houses, warehouse & scanning.
--
-- Safe-migration rules followed here:
--   * runs in ONE transaction — any failure leaves the database untouched
--   * new NOT NULL columns are added nullable, backfilled, then constrained
--   * no existing row, id or storage key is deleted or rewritten
--   * reverse script: prisma/rollback/20261025100000_inventory_phase2.down.sql
--   * dry run + reconciliation report: scripts/migration-dry-run.ps1
-- Partial unique indexes at the end are not representable in schema.prisma; if a
-- future `prisma migrate dev` proposes dropping them, remove those lines from
-- the generated migration.
BEGIN;

-- CreateEnum
CREATE TYPE "PhysicalStatus" AS ENUM ('AWAITING_STORAGE', 'IN_STORAGE', 'AWAITING_PICK', 'PICKED', 'PACKED', 'SHIPPED', 'MISSING');

-- CreateEnum
CREATE TYPE "CommercialStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'OFFERED', 'SOLD', 'UNSOLD', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BookSize" AS ENUM ('UNKNOWN', 'SMALL', 'MEDIUM', 'LARGE', 'OVERSIZE');

-- CreateEnum
CREATE TYPE "LotAssignmentStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "StatusDimension" AS ENUM ('PHOTO', 'PHYSICAL', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "DescriptionSource" AS ENUM ('MANUAL', 'AI', 'IMPORT');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('STORE', 'TRANSFER', 'PICK', 'RETURN', 'COUNT_ADJUST', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScanMode" AS ENUM ('STORE', 'TRANSFER', 'FIND', 'PICK', 'COUNT');

-- CreateEnum
CREATE TYPE "ScanResult" AS ENUM ('OK', 'NOOP', 'ERROR', 'CONFLICT');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'REVIEW', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PickStatus" AS ENUM ('OPEN', 'PICKED', 'PACKED', 'SHIPPED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'WAREHOUSE';

-- DropForeignKey
ALTER TABLE "PhotoAsset" DROP CONSTRAINT "PhotoAsset_catalogId_fkey";

-- DropForeignKey
ALTER TABLE "PhotoAsset" DROP CONSTRAINT "PhotoAsset_lotId_fkey";

-- DropIndex
DROP INDEX "Catalog_organizationId_number_key";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "inventoryItemId" UUID;

-- AlterTable
ALTER TABLE "CaptureSession" ADD COLUMN     "inventoryItemId" UUID,
ALTER COLUMN "catalogId" DROP NOT NULL,
ALTER COLUMN "lotId" DROP NOT NULL;


-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "assignedById" UUID,
ADD COLUMN     "assignmentStatus" "LotAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "commercialStatus" "CommercialStatus" NOT NULL DEFAULT 'ASSIGNED',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "endReason" TEXT,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "inventoryItemId" UUID,
ADD COLUMN     "pageRef" JSONB;

-- AlterTable
ALTER TABLE "Catalog" ADD COLUMN     "auctionHouseId" UUID;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "inventorySerialSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PhotoAsset" ADD COLUMN     "inventoryItemId" UUID,
ALTER COLUMN "catalogId" DROP NOT NULL,
ALTER COLUMN "lotId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AuctionHouse" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#1a1917',
    "accentColor" TEXT NOT NULL DEFAULT '#cf4416',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionHouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHouseAccess" (
    "userId" UUID NOT NULL,
    "auctionHouseId" UUID NOT NULL,

    CONSTRAINT "UserHouseAccess_pkey" PRIMARY KEY ("userId","auctionHouseId")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "serial" INTEGER NOT NULL,
    "inventoryNumber" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "author" TEXT,
    "printPlace" TEXT,
    "printYear" TEXT,
    "publisher" TEXT,
    "bibliographicNotes" TEXT,
    "internalNotes" TEXT,
    "conditionNotes" TEXT,
    "heightMm" INTEGER,
    "widthMm" INTEGER,
    "depthMm" INTEGER,
    "sizeCategory" "BookSize" NOT NULL DEFAULT 'UNKNOWN',
    "photoStatus" "LotStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "physicalStatus" "PhysicalStatus" NOT NULL DEFAULT 'AWAITING_STORAGE',
    "commercialStatus" "CommercialStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "requirements" JSONB NOT NULL,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "primaryAssetId" UUID,
    "currentLocationId" UUID,
    "locationUpdatedAt" TIMESTAMP(3),
    "migratedFromLotId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photoCompletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCategoryNote" (
    "inventoryItemId" UUID NOT NULL,
    "category" "PhotoCategory" NOT NULL,
    "needsReshoot" BOOLEAN NOT NULL DEFAULT false,
    "notRequired" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCategoryNote_pkey" PRIMARY KEY ("inventoryItemId","category")
);

-- CreateTable
CREATE TABLE "InventoryStatusEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "dimension" "StatusDimension" NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "userId" UUID,
    "reason" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAnalysis" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT,
    "input" JSONB,
    "result" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotDisplayAsset" (
    "lotId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "sortOrder" INTEGER,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LotDisplayAsset_pkey" PRIMARY KEY ("lotId","assetId")
);

-- CreateTable
CREATE TABLE "LotDescriptionVersion" (
    "id" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT,
    "shortDescription" TEXT,
    "description" TEXT,
    "source" "DescriptionSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotDescriptionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseZone" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shelf" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "shelfType" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shelf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shelfId" UUID NOT NULL,
    "cell" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sizeClass" "BookSize",
    "capacity" INTEGER,
    "isFull" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLocationMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "kind" "MovementKind" NOT NULL,
    "userId" UUID,
    "opId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLocationMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BarcodeScanEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "opId" UUID NOT NULL,
    "userId" UUID,
    "mode" "ScanMode" NOT NULL,
    "code" TEXT NOT NULL,
    "codeType" TEXT NOT NULL,
    "inventoryItemId" UUID,
    "locationId" UUID,
    "contextLocationId" UUID,
    "result" "ScanResult" NOT NULL,
    "message" TEXT,
    "clientAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deferred" BOOLEAN NOT NULL DEFAULT false,
    "deviceLabel" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,

    CONSTRAINT "BarcodeScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountSession" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "zoneId" UUID,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "startedById" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "result" JSONB,

    CONSTRAINT "StockCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLocation" (
    "sessionId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,

    CONSTRAINT "StockCountLocation_pkey" PRIMARY KEY ("sessionId","locationId")
);

-- CreateTable
CREATE TABLE "StockCountEntry" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "expectedLocationId" UUID,
    "scannedById" UUID,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "lotId" UUID,
    "reason" TEXT NOT NULL,
    "status" "PickStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "sourceLocationId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pickedById" UUID,
    "pickedAt" TIMESTAMP(3),
    "packedById" UUID,
    "packedAt" TIMESTAMP(3),
    "shippedById" UUID,
    "shippedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PickTask_pkey" PRIMARY KEY ("id")
);


-- ═══════════════════════════ BACKFILL ═══════════════════════════
-- Nothing below deletes or rewrites an existing id, storage key or file row.
-- Every legacy lot becomes one InventoryItem (migratedFromLotId keeps the link)
-- plus one ACTIVE catalog assignment (the lot row itself, unchanged id).

-- two auction houses per organization; existing catalogs belong to אבות
INSERT INTO "AuctionHouse" ("id", "organizationId", "slug", "name", "nameEn", "primaryColor", "accentColor", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'avot', 'אבות', 'AVOT', '#1a1917', '#cf4416', 1, CURRENT_TIMESTAMP FROM "Organization" o;
INSERT INTO "AuctionHouse" ("id", "organizationId", "slug", "name", "nameEn", "primaryColor", "accentColor", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'tavin', 'טבין', 'Tavin', '#18263a', '#2e6b8a', 2, CURRENT_TIMESTAMP FROM "Organization" o;

UPDATE "Catalog" c SET "auctionHouseId" = h."id"
FROM "AuctionHouse" h WHERE h."organizationId" = c."organizationId" AND h."slug" = 'avot';
ALTER TABLE "Catalog" ALTER COLUMN "auctionHouseId" SET NOT NULL;

-- one default warehouse per organization (zones / shelves are defined in the app)
INSERT INTO "Warehouse" ("id", "organizationId", "code", "name", "isDefault", "updatedAt")
SELECT gen_random_uuid(), o."id", 'MAIN', 'מחסן ראשי', true, CURRENT_TIMESTAMP FROM "Organization" o;

-- inventory items, numbered in catalog order (oldest catalog first, then lot number)
INSERT INTO "InventoryItem" (
  "id", "organizationId", "serial", "inventoryNumber", "barcode",
  "title", "subtitle", "author", "printPlace", "printYear", "internalNotes",
  "photoStatus", "physicalStatus", "commercialStatus", "requirements", "photoCount", "primaryAssetId",
  "migratedFromLotId", "receivedAt", "photoCompletedAt", "createdById", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(), l."organizationId", s.serial,
  'ITM-' || lpad(s.serial::text, 6, '0'), 'ITM-' || lpad(s.serial::text, 6, '0'),
  l."title", l."subtitle", l."author", l."printPlace", l."printYear", l."internalNotes",
  l."status", 'AWAITING_STORAGE', 'ASSIGNED', l."requirements", l."photoCount", l."primaryAssetId",
  l."id", l."createdAt", l."completedAt",
  (SELECT a."userId" FROM "AuditLog" a WHERE a."entityType" = 'lot' AND a."entityId" = l."id"::text AND a."action" = 'lot.created' ORDER BY a."createdAt" LIMIT 1),
  l."createdAt", l."updatedAt"
FROM "Lot" l
JOIN (
  SELECT l2."id", row_number() OVER (PARTITION BY l2."organizationId" ORDER BY c."createdAt", c."number", l2."lotNumber", l2."id") AS serial
  FROM "Lot" l2 JOIN "Catalog" c ON c."id" = l2."catalogId"
) s ON s."id" = l."id";

UPDATE "Organization" o SET "inventorySerialSeq" = COALESCE((SELECT max(i."serial") FROM "InventoryItem" i WHERE i."organizationId" = o."id"), 0);

UPDATE "Lot" l SET
  "inventoryItemId" = i."id",
  "assignedAt" = l."createdAt",
  "assignedById" = i."createdById"
FROM "InventoryItem" i WHERE i."migratedFromLotId" = l."id";
ALTER TABLE "Lot" ALTER COLUMN "inventoryItemId" SET NOT NULL;

-- photos: owner = the item; lotId / catalogId stay as provenance
UPDATE "PhotoAsset" p SET "inventoryItemId" = l."inventoryItemId" FROM "Lot" l WHERE l."id" = p."lotId";
ALTER TABLE "PhotoAsset" ALTER COLUMN "inventoryItemId" SET NOT NULL;

UPDATE "CaptureSession" s SET "inventoryItemId" = l."inventoryItemId" FROM "Lot" l WHERE l."id" = s."lotId";

INSERT INTO "InventoryCategoryNote" ("inventoryItemId", "category", "needsReshoot", "notRequired", "note", "updatedAt")
SELECT l."inventoryItemId", n."category", n."needsReshoot", n."notRequired", n."note", n."updatedAt"
FROM "LotCategoryNote" n JOIN "Lot" l ON l."id" = n."lotId";

-- history: every existing audit row about a lot is also attached to its book
UPDATE "AuditLog" a SET "inventoryItemId" = l."inventoryItemId" FROM "Lot" l WHERE l."id" = a."lotId";
UPDATE "AuditLog" a SET "inventoryItemId" = l."inventoryItemId"
FROM "Lot" l WHERE a."inventoryItemId" IS NULL AND a."entityType" = 'lot' AND a."entityId" = l."id"::text;

INSERT INTO "AuditLog" ("id", "organizationId", "action", "entityType", "entityId", "lotId", "inventoryItemId", "data")
SELECT gen_random_uuid(), i."organizationId", 'inventory.migrated', 'inventory', i."id"::text, l."id", i."id",
       jsonb_build_object('fromLotId', l."id", 'catalogId', l."catalogId", 'lotNumber', l."lotNumber", 'inventoryNumber', i."inventoryNumber")
FROM "InventoryItem" i JOIN "Lot" l ON l."id" = i."migratedFromLotId";

INSERT INTO "InventoryStatusEvent" ("id", "organizationId", "inventoryItemId", "dimension", "fromStatus", "toStatus", "reason", "refType", "refId")
SELECT gen_random_uuid(), i."organizationId", i."id", d.dim::"StatusDimension", NULL, d.st, 'מיגרציה ממבנה קטלוגים', 'lot', i."migratedFromLotId"::text
FROM "InventoryItem" i
CROSS JOIN LATERAL (VALUES ('PHOTO', i."photoStatus"::text), ('PHYSICAL', i."physicalStatus"::text), ('COMMERCIAL', i."commercialStatus"::text)) AS d(dim, st)
WHERE i."migratedFromLotId" IS NOT NULL;

-- description history starts with what the lot holds today
INSERT INTO "LotDescriptionVersion" ("id", "lotId", "version", "title", "shortDescription", "source", "createdAt")
SELECT gen_random_uuid(), l."id", 1, l."title", l."shortDescription", 'IMPORT', l."updatedAt" FROM "Lot" l;

-- CreateIndex
CREATE UNIQUE INDEX "AuctionHouse_organizationId_slug_key" ON "AuctionHouse"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_migratedFromLotId_key" ON "InventoryItem"("migratedFromLotId");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_updatedAt_idx" ON "InventoryItem"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_physicalStatus_idx" ON "InventoryItem"("organizationId", "physicalStatus");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_commercialStatus_idx" ON "InventoryItem"("organizationId", "commercialStatus");

-- CreateIndex
CREATE INDEX "InventoryItem_organizationId_photoStatus_idx" ON "InventoryItem"("organizationId", "photoStatus");

-- CreateIndex
CREATE INDEX "InventoryItem_currentLocationId_idx" ON "InventoryItem"("currentLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_organizationId_serial_key" ON "InventoryItem"("organizationId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_organizationId_inventoryNumber_key" ON "InventoryItem"("organizationId", "inventoryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_organizationId_barcode_key" ON "InventoryItem"("organizationId", "barcode");

-- CreateIndex
CREATE INDEX "InventoryStatusEvent_inventoryItemId_createdAt_idx" ON "InventoryStatusEvent"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryAnalysis_inventoryItemId_createdAt_idx" ON "InventoryAnalysis"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LotDescriptionVersion_lotId_version_key" ON "LotDescriptionVersion"("lotId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_organizationId_code_key" ON "Warehouse"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseZone_warehouseId_code_key" ON "WarehouseZone"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Shelf_zoneId_code_key" ON "Shelf"("zoneId", "code");

-- CreateIndex
CREATE INDEX "StorageLocation_organizationId_sortKey_idx" ON "StorageLocation"("organizationId", "sortKey");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_organizationId_code_key" ON "StorageLocation"("organizationId", "code");

-- CreateIndex
CREATE INDEX "InventoryLocationMovement_inventoryItemId_occurredAt_idx" ON "InventoryLocationMovement"("inventoryItemId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocationMovement_organizationId_opId_key" ON "InventoryLocationMovement"("organizationId", "opId");

-- CreateIndex
CREATE INDEX "BarcodeScanEvent_organizationId_receivedAt_idx" ON "BarcodeScanEvent"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "BarcodeScanEvent_organizationId_result_resolvedAt_idx" ON "BarcodeScanEvent"("organizationId", "result", "resolvedAt");

-- CreateIndex
CREATE INDEX "BarcodeScanEvent_inventoryItemId_idx" ON "BarcodeScanEvent"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "BarcodeScanEvent_organizationId_opId_key" ON "BarcodeScanEvent"("organizationId", "opId");

-- CreateIndex
CREATE INDEX "StockCountSession_organizationId_status_idx" ON "StockCountSession"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountEntry_sessionId_inventoryItemId_key" ON "StockCountEntry"("sessionId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "PickTask_organizationId_status_idx" ON "PickTask"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PickTask_inventoryItemId_idx" ON "PickTask"("inventoryItemId");

-- CreateIndex
CREATE INDEX "AuditLog_inventoryItemId_createdAt_idx" ON "AuditLog"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Catalog_auctionHouseId_number_key" ON "Catalog"("auctionHouseId", "number");

-- CreateIndex
CREATE INDEX "Lot_inventoryItemId_idx" ON "Lot"("inventoryItemId");

-- CreateIndex
CREATE INDEX "PhotoAsset_inventoryItemId_category_deletedAt_sortOrder_idx" ON "PhotoAsset"("inventoryItemId", "category", "deletedAt", "sortOrder");

-- AddForeignKey
ALTER TABLE "AuctionHouse" ADD CONSTRAINT "AuctionHouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHouseAccess" ADD CONSTRAINT "UserHouseAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHouseAccess" ADD CONSTRAINT "UserHouseAccess_auctionHouseId_fkey" FOREIGN KEY ("auctionHouseId") REFERENCES "AuctionHouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "StorageLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategoryNote" ADD CONSTRAINT "InventoryCategoryNote_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryStatusEvent" ADD CONSTRAINT "InventoryStatusEvent_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAnalysis" ADD CONSTRAINT "InventoryAnalysis_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Catalog" ADD CONSTRAINT "Catalog_auctionHouseId_fkey" FOREIGN KEY ("auctionHouseId") REFERENCES "AuctionHouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotDisplayAsset" ADD CONSTRAINT "LotDisplayAsset_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotDisplayAsset" ADD CONSTRAINT "LotDisplayAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PhotoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotDescriptionVersion" ADD CONSTRAINT "LotDescriptionVersion_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAsset" ADD CONSTRAINT "PhotoAsset_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAsset" ADD CONSTRAINT "PhotoAsset_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAsset" ADD CONSTRAINT "PhotoAsset_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseZone" ADD CONSTRAINT "WarehouseZone_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shelf" ADD CONSTRAINT "Shelf_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "WarehouseZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StorageLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StorageLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountSession" ADD CONSTRAINT "StockCountSession_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "WarehouseZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLocation" ADD CONSTRAINT "StockCountLocation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StockCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountEntry" ADD CONSTRAINT "StockCountEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StockCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════ invariants Prisma cannot express ═══════════════
-- at most one ACTIVE catalog assignment per physical book
CREATE UNIQUE INDEX "Lot_inventoryItemId_active_key" ON "Lot"("inventoryItemId") WHERE "assignmentStatus" = 'ACTIVE';
-- at most one open pick task (not shipped / cancelled) per book
CREATE UNIQUE INDEX "PickTask_inventoryItemId_open_key" ON "PickTask"("inventoryItemId") WHERE "status" IN ('OPEN', 'PICKED', 'PACKED');
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_dimensions_check"
  CHECK (("heightMm" IS NULL OR "heightMm" > 0) AND ("widthMm" IS NULL OR "widthMm" > 0) AND ("depthMm" IS NULL OR "depthMm" > 0));

COMMIT;
