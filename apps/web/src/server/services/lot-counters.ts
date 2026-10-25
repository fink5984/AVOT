import "server-only";
import type { Tx } from "../db";

/**
 * Recomputes the denormalised photo counter and primary photo of an inventory
 * item, and mirrors the counter onto every catalog lot of that item (lists
 * read Lot.photoCount without joining photos).
 */
export async function recountItem(tx: Tx, itemId: string) {
  const [count, primary] = await Promise.all([
    tx.photoAsset.count({ where: { inventoryItemId: itemId, deletedAt: null } }),
    tx.photoAsset.findFirst({ where: { inventoryItemId: itemId, deletedAt: null, isPrimary: true }, select: { id: true } }),
  ]);
  await tx.inventoryItem.update({ where: { id: itemId }, data: { photoCount: count, primaryAssetId: primary?.id ?? null } });
  await tx.lot.updateMany({ where: { inventoryItemId: itemId }, data: { photoCount: count } });
  // a lot-specific primary photo that was deleted falls back to the item's primary
  await tx.$executeRaw`
    UPDATE "Lot" SET "primaryAssetId" = NULL
    WHERE "inventoryItemId" = ${itemId}::uuid AND "primaryAssetId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "PhotoAsset" p WHERE p.id = "Lot"."primaryAssetId" AND p."deletedAt" IS NULL AND p."inventoryItemId" = ${itemId}::uuid)`;
}

/** Row lock on the item — serialises sequence/sort allocation for concurrent captures. */
export async function lockItem(tx: Tx, itemId: string) {
  await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
}
