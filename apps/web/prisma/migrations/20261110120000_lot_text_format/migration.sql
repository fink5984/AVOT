-- Character formatting of a lot's texts (additive, nullable: existing lots stay plain text)
ALTER TABLE "Lot" ADD COLUMN "textFormat" JSONB;
