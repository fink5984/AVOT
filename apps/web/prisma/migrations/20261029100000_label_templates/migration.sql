-- AVOT Studio — one calibration profile per label type and organization (book / shelf / column labels).
-- Additive only: a new table; nothing existing is touched. Without a row the built-in professional defaults apply.
CREATE TABLE "LabelTemplate" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "profile" JSONB NOT NULL,
  "updatedById" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LabelTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LabelTemplate_organizationId_type_key" ON "LabelTemplate"("organizationId", "type");
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
