-- AI background rewrite + external research. Additive only (no data is changed or removed).

ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'AI_REWRITE';

ALTER TABLE "InventoryAnalysis" ADD COLUMN "research" JSONB;
ALTER TABLE "InventoryAnalysis" ADD COLUMN "baseDetailsVersion" INTEGER;

ALTER TABLE "AiSettings" ADD COLUMN "researchEnabled" BOOLEAN;
ALTER TABLE "AiSettings" ADD COLUMN "researchMaxSources" INTEGER;
ALTER TABLE "AiSettings" ADD COLUMN "researchTimeoutSeconds" INTEGER;
ALTER TABLE "AiSettings" ADD COLUMN "researchMaxSearches" INTEGER;
ALTER TABLE "AiSettings" ADD COLUMN "researchMaxCostUsd" DECIMAL(8,4);
ALTER TABLE "AiSettings" ADD COLUMN "researchProvider" TEXT;

ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchEnabled" BOOLEAN;
ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchMaxSources" INTEGER;
ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchTimeoutSeconds" INTEGER;
ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchMaxSearches" INTEGER;
ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchMaxCostUsd" DECIMAL(8,4);
ALTER TABLE "AiSettingsVersion" ADD COLUMN "researchProvider" TEXT;
