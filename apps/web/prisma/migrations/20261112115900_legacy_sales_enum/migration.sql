-- the new value must be committed before the next migration uses it
ALTER TYPE "PurchaseSource" ADD VALUE IF NOT EXISTS 'LEGACY_MANUAL';
