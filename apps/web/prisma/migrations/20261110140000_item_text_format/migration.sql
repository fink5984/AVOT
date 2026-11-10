-- Character formatting of a book's texts in inventory (additive, nullable: existing books stay plain text)
ALTER TABLE "InventoryItem" ADD COLUMN "textFormat" JSONB;
