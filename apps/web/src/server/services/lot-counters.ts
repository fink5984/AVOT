import "server-only";
import type { Tx } from "../db";
import { refreshLotsOfItem } from "./lot-members";

/**
 * Recomputes the denormalised photo counter and primary photo of an inventory
 * item, and mirrors the counters onto every catalog lot the item belongs to (lists
 * read Lot.photoCount without joining photos; a combined lot sums its books).
 */
export async function recountItem(tx: Tx, itemId: string) {
  const [count, primary] = await Promise.all([
    tx.photoAsset.count({ where: { inventoryItemId: itemId, deletedAt: null } }),
    tx.photoAsset.findFirst({ where: { inventoryItemId: itemId, deletedAt: null, isPrimary: true }, select: { id: true } }),
  ]);
  await tx.inventoryItem.update({ where: { id: itemId }, data: { photoCount: count, primaryAssetId: primary?.id ?? null } });
  await refreshLotsOfItem(tx, itemId);
  // a lot-specific primary photo that was deleted falls back to the lot's default (the item's primary / the first photo)
  await tx.$executeRaw`
    UPDATE "Lot" SET "primaryAssetId" = NULL
    WHERE "primaryAssetId" IS NOT NULL
      AND id IN (SELECT "lotId" FROM "LotMember" WHERE "inventoryItemId" = ${itemId}::uuid AND "removedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "PhotoAsset" p WHERE p.id = "Lot"."primaryAssetId" AND p."deletedAt" IS NULL)`;
}

/** Row lock on the item — serialises sequence/sort allocation for concurrent captures. */
export async function lockItem(tx: Tx, itemId: string) {
  await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
}
