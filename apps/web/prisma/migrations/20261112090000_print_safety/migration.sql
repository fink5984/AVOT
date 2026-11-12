-- Print safety: the whole click's label count and the number the person confirmed (additive, nullable).
ALTER TABLE "PrintJob" ADD COLUMN "batchLabelCount" INTEGER, ADD COLUMN "confirmedCount" INTEGER;
