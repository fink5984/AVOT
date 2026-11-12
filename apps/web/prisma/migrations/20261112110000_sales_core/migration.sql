-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'MERGED');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseSource" AS ENUM ('IMPORT', 'MANUAL', 'POST_SALE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentMethod" AS ENUM ('CARRIER', 'PICKUP', 'HAND_DELIVERY');

-- CreateEnum
CREATE TYPE "SaleImportStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'DISCARDED');

-- DropForeignKey
ALTER TABLE "LotAiRun" DROP CONSTRAINT "LotAiRun_lotId_fkey";

-- AlterTable
ALTER TABLE "Catalog" ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "saleFinishedAt" TIMESTAMP(3),
ADD COLUMN     "saleFinishedById" UUID;

-- AlterTable
ALTER TABLE "PickTask" ADD COLUMN     "purchaseId" UUID;

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "emailNorm" TEXT,
    "phone" TEXT,
    "phoneNorm" TEXT,
    "addresses" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "needsDetails" BOOLEAN NOT NULL DEFAULT false,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerExternalIdentity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerOrder" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "catalogId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "externalOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "catalogId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "PurchaseSource" NOT NULL DEFAULT 'MANUAL',
    "afterAuction" BOOLEAN NOT NULL DEFAULT false,
    "hammerPrice" DECIMAL(12,2) NOT NULL,
    "buyerPremium" DECIMAL(12,2),
    "tax" DECIMAL(12,2),
    "startingPriceAtSale" DECIMAL(12,2),
    "bidderNumber" TEXT,
    "externalTransactionId" TEXT,
    "importId" UUID,
    "manualFields" JSONB NOT NULL DEFAULT '[]',
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,
    "releasedUnpaid" BOOLEAN NOT NULL DEFAULT false,
    "releaseNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "refundNote" TEXT,
    "returnedToStock" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "recordedById" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "method" "ShipmentMethod" NOT NULL DEFAULT 'CARRIER',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "cost" DECIMAL(12,2),
    "recipient" JSONB NOT NULL,
    "notes" TEXT,
    "partialConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packedAt" TIMESTAMP(3),
    "packedById" UUID,
    "shippedAt" TIMESTAMP(3),
    "shippedById" UUID,
    "deliveredAt" TIMESTAMP(3),
    "deliveredById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" UUID,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    "removeReason" TEXT,
    "returnedAt" TIMESTAMP(3),
    "returnedById" UUID,
    "returnReason" TEXT,
    "returnCondition" TEXT,
    "returnLocationId" UUID,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "purchaseId" UUID,
    "customerId" UUID,
    "shipmentId" UUID,
    "catalogId" UUID,
    "kind" TEXT NOT NULL,
    "data" JSONB,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleResultImport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "catalogId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "buyersFileName" TEXT,
    "buyersFileHash" TEXT,
    "storageKey" TEXT,
    "buyersStorageKey" TEXT,
    "mapping" JSONB NOT NULL,
    "status" "SaleImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "summary" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "committedById" UUID,

    CONSTRAINT "SaleResultImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleResultImportRow" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "lotId" UUID,
    "outcome" TEXT NOT NULL,
    "hammerPrice" DECIMAL(12,2),
    "customerId" UUID,
    "customerMatch" TEXT NOT NULL DEFAULT 'NONE',
    "action" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "purchaseId" UUID,

    CONSTRAINT "SaleResultImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleImportTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleImportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_organizationId_emailNorm_idx" ON "Customer"("organizationId", "emailNorm");

-- CreateIndex
CREATE INDEX "Customer_organizationId_phoneNorm_idx" ON "Customer"("organizationId", "phoneNorm");

-- CreateIndex
CREATE INDEX "Customer_organizationId_name_idx" ON "Customer"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_organizationId_number_key" ON "Customer"("organizationId", "number");

-- CreateIndex
CREATE INDEX "CustomerExternalIdentity_customerId_idx" ON "CustomerExternalIdentity"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerExternalIdentity_organizationId_system_context_kind_key" ON "CustomerExternalIdentity"("organizationId", "system", "context", "kind", "externalId");

-- CreateIndex
CREATE INDEX "BuyerOrder_customerId_idx" ON "BuyerOrder"("customerId");

-- CreateIndex
CREATE INDEX "BuyerOrder_organizationId_catalogId_idx" ON "BuyerOrder"("organizationId", "catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerOrder_catalogId_customerId_key" ON "BuyerOrder"("catalogId", "customerId");

-- CreateIndex
CREATE INDEX "Purchase_organizationId_status_idx" ON "Purchase"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Purchase_customerId_status_idx" ON "Purchase"("customerId", "status");

-- CreateIndex
CREATE INDEX "Purchase_orderId_idx" ON "Purchase"("orderId");

-- CreateIndex
CREATE INDEX "Purchase_catalogId_status_idx" ON "Purchase"("catalogId", "status");

-- CreateIndex
CREATE INDEX "Purchase_lotId_idx" ON "Purchase"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_organizationId_externalTransactionId_key" ON "Purchase"("organizationId", "externalTransactionId");

-- CreateIndex
CREATE INDEX "Payment_orderId_status_idx" ON "Payment"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_externalId_key" ON "Payment"("organizationId", "externalId");

-- CreateIndex
CREATE INDEX "Shipment_customerId_status_idx" ON "Shipment"("customerId", "status");

-- CreateIndex
CREATE INDEX "Shipment_organizationId_status_idx" ON "Shipment"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_organizationId_number_key" ON "Shipment"("organizationId", "number");

-- CreateIndex
CREATE INDEX "ShipmentItem_shipmentId_isActive_idx" ON "ShipmentItem"("shipmentId", "isActive");

-- CreateIndex
CREATE INDEX "ShipmentItem_purchaseId_idx" ON "ShipmentItem"("purchaseId");

-- CreateIndex
CREATE INDEX "ShipmentItem_inventoryItemId_isActive_idx" ON "ShipmentItem"("inventoryItemId", "isActive");

-- CreateIndex
CREATE INDEX "SaleEvent_purchaseId_createdAt_idx" ON "SaleEvent"("purchaseId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleEvent_customerId_createdAt_idx" ON "SaleEvent"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleEvent_shipmentId_createdAt_idx" ON "SaleEvent"("shipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleEvent_catalogId_createdAt_idx" ON "SaleEvent"("catalogId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleResultImport_catalogId_createdAt_idx" ON "SaleResultImport"("catalogId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleResultImport_organizationId_fileHash_idx" ON "SaleResultImport"("organizationId", "fileHash");

-- CreateIndex
CREATE INDEX "SaleResultImportRow_importId_rowIndex_idx" ON "SaleResultImportRow"("importId", "rowIndex");

-- CreateIndex
CREATE UNIQUE INDEX "SaleImportTemplate_organizationId_kind_name_key" ON "SaleImportTemplate"("organizationId", "kind", "name");

-- AddForeignKey
ALTER TABLE "LotAiRun" ADD CONSTRAINT "LotAiRun_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerExternalIdentity" ADD CONSTRAINT "CustomerExternalIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerOrder" ADD CONSTRAINT "BuyerOrder_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerOrder" ADD CONSTRAINT "BuyerOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BuyerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BuyerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleResultImport" ADD CONSTRAINT "SaleResultImport_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleResultImportRow" ADD CONSTRAINT "SaleResultImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "SaleResultImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Business rules the database itself enforces ------------------------------------------------------------
-- one ACTIVE purchase per lot: a repeated import / a double click can never sell a lot twice
CREATE UNIQUE INDEX "Purchase_lot_active_key" ON "Purchase"("lotId") WHERE "status" = 'ACTIVE';
-- a physical book is in at most one ACTIVE shipment
CREATE UNIQUE INDEX "ShipmentItem_item_active_key" ON "ShipmentItem"("inventoryItemId") WHERE "isActive";
-- a book is listed once per shipment
CREATE UNIQUE INDEX "ShipmentItem_shipment_item_active_key" ON "ShipmentItem"("shipmentId", "inventoryItemId") WHERE "isActive";
-- money is never negative; a payment is a real amount
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_money_nonneg" CHECK ("hammerPrice" >= 0 AND ("buyerPremium" IS NULL OR "buyerPremium" >= 0) AND ("tax" IS NULL OR "tax" >= 0));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_pos" CHECK ("amount" > 0);
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_cost_nonneg" CHECK ("cost" IS NULL OR "cost" >= 0);
