-- AVOT Studio — workflow upgrade: idempotent book creation, permanent-deletion bookkeeping,
-- label printers and the durable print queue, print-agent devices.
--
-- Additive only: new nullable / defaulted columns, new tables, new enum values. No existing row,
-- id, barcode, inventory number or storage key is changed. Reverse: prisma/rollback/20261027090000_workflow_upgrade.down.sql

-- enum values cannot be used in the transaction that adds them, so nothing below references them
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'DELETE_ITEMS';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'DELETE_CATALOGS';

BEGIN;

CREATE TYPE "PrintJobKind" AS ENUM ('BOOK', 'LOCATION', 'TEST');
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'DONE', 'FAILED', 'CANCELLED');
CREATE TYPE "PrinterConnection" AS ENUM ('NETWORK', 'WINDOWS');

ALTER TABLE "InventoryItem"
  ADD COLUMN "createOpId" UUID,
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "deletionRequestedById" UUID;
CREATE UNIQUE INDEX "InventoryItem_organizationId_createOpId_key" ON "InventoryItem"("organizationId", "createOpId");
CREATE INDEX "InventoryItem_organizationId_deletionRequestedAt_idx" ON "InventoryItem"("organizationId", "deletionRequestedAt") WHERE "deletionRequestedAt" IS NOT NULL;

ALTER TABLE "Device" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CAPTURE', ADD COLUMN "printStatus" JSONB;
ALTER TABLE "PairingCode" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CAPTURE';

CREATE TABLE "Printer" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "model" TEXT,
  "connection" "PrinterConnection" NOT NULL DEFAULT 'NETWORK',
  "host" TEXT,
  "port" INTEGER NOT NULL DEFAULT 9100,
  "windowsName" TEXT,
  "labelSize" TEXT NOT NULL DEFAULT '57x32',
  "language" TEXT NOT NULL DEFAULT 'ZPL',
  "dotsPerMm" INTEGER NOT NULL DEFAULT 8,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "agentId" UUID,
  "lastStatus" TEXT,
  "lastStatusAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Printer_organizationId_idx" ON "Printer"("organizationId");
-- at most one primary printer per organization
CREATE UNIQUE INDEX "Printer_organizationId_primary_key" ON "Printer"("organizationId") WHERE "isPrimary";
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PrintJob" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "printerId" UUID,
  "kind" "PrintJobKind" NOT NULL,
  "items" JSONB NOT NULL,
  "copies" INTEGER NOT NULL DEFAULT 1,
  "labelCount" INTEGER NOT NULL DEFAULT 1,
  "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "idemKey" TEXT,
  "summary" TEXT,
  "createdById" UUID,
  "claimedById" UUID,
  "claimedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "doneAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintJob_organizationId_idemKey_key" ON "PrintJob"("organizationId", "idemKey");
CREATE INDEX "PrintJob_organizationId_status_createdAt_idx" ON "PrintJob"("organizationId", "status", "createdAt");
CREATE INDEX "PrintJob_status_createdAt_idx" ON "PrintJob"("status", "createdAt");
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
