-- Reverse of 20261027090000_workflow_upgrade. Refuses to run when a deletion is in flight, because the
-- hidden books could not be told apart from live ones afterwards. The two added JobType enum values
-- cannot be removed from PostgreSQL and are harmless.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryItem" WHERE "deletionRequestedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'books are pending permanent deletion — let the delete jobs finish first';
  END IF;
END $$;
DROP TABLE IF EXISTS "PrintJob";
DROP TABLE IF EXISTS "Printer";
DROP TYPE IF EXISTS "PrintJobKind";
DROP TYPE IF EXISTS "PrintJobStatus";
DROP TYPE IF EXISTS "PrinterConnection";
ALTER TABLE "PairingCode" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "kind", DROP COLUMN IF EXISTS "printStatus";
DROP INDEX IF EXISTS "InventoryItem_organizationId_deletionRequestedAt_idx";
DROP INDEX IF EXISTS "InventoryItem_organizationId_createOpId_key";
ALTER TABLE "InventoryItem" DROP COLUMN IF EXISTS "createOpId", DROP COLUMN IF EXISTS "deletionRequestedAt", DROP COLUMN IF EXISTS "deletionRequestedById";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261027090000_workflow_upgrade';
COMMIT;
