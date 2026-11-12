-- Starting price (USD) on the catalog lot, its history, and what happens to unsold lots. Additive.
CREATE TYPE "UnsoldDisposition" AS ENUM ('NONE', 'HOLD_POST_SALE', 'RELEASED_TO_STOCK', 'RETURN_TO_CONSIGNOR');

ALTER TABLE "Lot"
  ADD COLUMN "startingPrice" DECIMAL(12,2),
  ADD COLUMN "priceVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unsoldDisposition" "UnsoldDisposition" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "externalRef" TEXT;
-- a price is never negative; "no price" is NULL, not 0
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_startingPrice_nonneg" CHECK ("startingPrice" IS NULL OR "startingPrice" > 0);

CREATE TABLE "LotPriceEvent" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  -- set to NULL if the lot row is ever deleted (a mistaken assignment): the history of the price stays
  "lotId" UUID,
  "catalogId" UUID NOT NULL,
  "lotNumber" INTEGER,
  "kind" TEXT NOT NULL,
  "previous" DECIMAL(12,2),
  "next" DECIMAL(12,2),
  "note" TEXT,
  "data" JSONB,
  "userId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LotPriceEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LotPriceEvent_lotId_createdAt_idx" ON "LotPriceEvent"("lotId", "createdAt");
CREATE INDEX "LotPriceEvent_organizationId_createdAt_idx" ON "LotPriceEvent"("organizationId", "createdAt");
ALTER TABLE "LotPriceEvent" ADD CONSTRAINT "LotPriceEvent_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
