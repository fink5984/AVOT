-- Reverse of 20261026090000_book_processing. Processed images in object storage are not deleted here
-- (keys: orgs/<org>/processed/…); the two added enum values cannot be removed and are harmless.
BEGIN;
ALTER TABLE "CameraProfile" DROP CONSTRAINT IF EXISTS "CameraProfile_organizationId_fkey";
DROP TABLE IF EXISTS "CameraProfile";
DROP INDEX IF EXISTS "PhotoAsset_imageState_idx";
ALTER TABLE "PhotoAsset"
  DROP COLUMN IF EXISTS "imageState",
  DROP COLUMN IF EXISTS "processing",
  DROP COLUMN IF EXISTS "processingResult",
  DROP COLUMN IF EXISTS "processedKey",
  DROP COLUMN IF EXISTS "processedMime",
  DROP COLUMN IF EXISTS "processedWidth",
  DROP COLUMN IF EXISTS "processedHeight";
DROP TYPE IF EXISTS "ImageProcessingState";
COMMIT;
