-- Final approval of a book's details: a permission that can be granted to individual users, and the details version that was approved.
ALTER TABLE "User" ADD COLUMN "extraPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "InventoryItem" ADD COLUMN "approvedVersion" INTEGER;
-- books already approved: the approved version is the current one
UPDATE "InventoryItem" SET "approvedVersion" = "detailsVersion" WHERE "reviewStatus" = 'APPROVED';
