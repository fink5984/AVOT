-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "originalBaseline" JSONB,
ADD COLUMN     "originalBaselineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InventoryAnalysis" ADD COLUMN     "settingsVersion" INTEGER;

-- CreateTable
CREATE TABLE "AiSettings" (
    "organizationId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "reasoning" TEXT,
    "analysisPrompt" TEXT,
    "manuscriptPrompt" TEXT,
    "rewritePrompt" TEXT,
    "fullRewritePrompt" TEXT,
    "examples" JSONB,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AiSettingsVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "reasoning" TEXT,
    "analysisPrompt" TEXT,
    "manuscriptPrompt" TEXT,
    "rewritePrompt" TEXT,
    "fullRewritePrompt" TEXT,
    "examples" JSONB,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSettingsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSettingsVersion_organizationId_version_key" ON "AiSettingsVersion"("organizationId", "version");

