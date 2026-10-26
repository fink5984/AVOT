-- AVOT Studio — green-screen processing: processed image, camera profiles, digiCamControl source.
--
-- Additive only: new nullable columns / new table / new enum values. No existing row,
-- id or storage key is changed. Reverse: prisma/rollback/20261026090000_book_processing.down.sql

-- CaptureSource / JobType enum values cannot be used in the same transaction that adds them,
-- so nothing below references them.
ALTER TYPE "CaptureSource" ADD VALUE IF NOT EXISTS 'DIGICAMCONTROL';
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'PROCESS_FINAL';

BEGIN;

CREATE TYPE "ImageProcessingState" AS ENUM ('NONE', 'QUEUED', 'PREVIEW_READY', 'DONE', 'NEEDS_REVIEW', 'FAILED');

ALTER TABLE "PhotoAsset"
  ADD COLUMN "imageState" "ImageProcessingState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "processing" JSONB,
  ADD COLUMN "processingResult" JSONB,
  ADD COLUMN "processedKey" TEXT,
  ADD COLUMN "processedMime" TEXT,
  ADD COLUMN "processedWidth" INTEGER,
  ADD COLUMN "processedHeight" INTEGER;

CREATE INDEX "PhotoAsset_imageState_idx" ON "PhotoAsset"("imageState") WHERE "imageState" IN ('QUEUED', 'PREVIEW_READY');

CREATE TABLE "CameraProfile" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "settings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CameraProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CameraProfile_organizationId_name_key" ON "CameraProfile"("organizationId", "name");
CREATE INDEX "CameraProfile_organizationId_idx" ON "CameraProfile"("organizationId");
-- one default profile per organization (not representable in schema.prisma)
CREATE UNIQUE INDEX "CameraProfile_default_key" ON "CameraProfile"("organizationId") WHERE "isDefault";

ALTER TABLE "CameraProfile" ADD CONSTRAINT "CameraProfile_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
