-- AVOT Studio — consignors (מפקידים) and photographer notes (הערות המצלם).
-- Additive only: one new table and new NULLABLE columns on InventoryItem. No existing row, id, barcode, photo,
-- catalog assignment or history is touched, and no placeholder consignor is created: books received before this
-- migration simply have consignorId = NULL ("ספרים ללא מפקיד") until someone fills them in. The "every NEW book has a
-- consignor" rule is enforced in the application (createItemTx), which is the only code path that inserts books.

CREATE TABLE "Consignor" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "notes" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Consignor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Consignor_organizationId_name_idx" ON "Consignor"("organizationId", "name");
CREATE INDEX "Consignor_organizationId_archivedAt_idx" ON "Consignor"("organizationId", "archivedAt");
ALTER TABLE "Consignor" ADD CONSTRAINT "Consignor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryItem"
  ADD COLUMN "consignorId" UUID,
  ADD COLUMN "photographerNotes" TEXT,
  ADD COLUMN "photographerNotesRev" BIGINT,
  ADD COLUMN "photographerNotesAt" TIMESTAMP(3),
  ADD COLUMN "photographerNotesById" UUID;
CREATE INDEX "InventoryItem_organizationId_consignorId_idx" ON "InventoryItem"("organizationId", "consignorId");
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_consignorId_fkey" FOREIGN KEY ("consignorId") REFERENCES "Consignor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
