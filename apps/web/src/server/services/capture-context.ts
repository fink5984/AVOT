import "server-only";
import type { LotStatus } from "@avot/shared";
import { db } from "../db";
import { listAssets } from "./assets";
import { toAssetDto, type AssetDto } from "./asset-dto";

/**
 * What the capture studio works on. Photos always belong to the inventory
 * item; the target only decides the navigation context:
 *   "lot"  — opened from a catalog: prev/next walk the catalog's lot numbers
 *   "item" — opened from inventory / a scanned tag: prev/next walk inventory numbers
 * `lot` / `catalog` keep the shape the studio and the Capture Agent use; for an
 * item target they describe the inventory (catalog "INV", number = serial), so
 * the agent's local folders become Catalog-INV/Lot-000184.
 */
export interface CaptureLotContext {
  target: "lot" | "item";
  item: { id: string; inventoryNumber: string; serial: number };
  lot: { id: string; lotNumber: number; title: string; subtitle: string | null; author: string | null; status: LotStatus; catalogId: string };
  catalog: { id: string; number: string; name: string };
  prev: { id: string; lotNumber: number; title: string } | null;
  next: { id: string; lotNumber: number; title: string } | null;
  assets: AssetDto[];
}

export const INVENTORY_CATALOG_NUMBER = "INV";

export async function loadCaptureContext(orgId: string, targetId: string): Promise<CaptureLotContext | null> {
  const lot = await db.lot.findFirst({ where: { id: targetId, organizationId: orgId }, include: { catalog: true, item: true } });
  if (lot) {
    const [prev, next, assets] = await Promise.all([
      db.lot.findFirst({ where: { catalogId: lot.catalogId, lotNumber: { lt: lot.lotNumber } }, orderBy: { lotNumber: "desc" }, select: { id: true, lotNumber: true, title: true } }),
      db.lot.findFirst({ where: { catalogId: lot.catalogId, lotNumber: { gt: lot.lotNumber } }, orderBy: { lotNumber: "asc" }, select: { id: true, lotNumber: true, title: true } }),
      listAssets(orgId, lot.inventoryItemId),
    ]);
    return {
      target: "lot",
      item: { id: lot.item.id, inventoryNumber: lot.item.inventoryNumber, serial: Number(lot.item.serial) },
      lot: { id: lot.id, lotNumber: lot.lotNumber, title: lot.title, subtitle: lot.subtitle, author: lot.author, status: lot.item.photoStatus, catalogId: lot.catalogId },
      catalog: { id: lot.catalog.id, number: lot.catalog.number, name: lot.catalog.name },
      prev,
      next,
      assets: assets.map(toAssetDto),
    };
  }
  const item = await db.inventoryItem.findFirst({ where: { id: targetId, organizationId: orgId } });
  if (!item) return null;
  const [prev, next, assets] = await Promise.all([
    db.inventoryItem.findFirst({ where: { organizationId: orgId, deletionRequestedAt: null, serial: { lt: item.serial } }, orderBy: { serial: "desc" }, select: { id: true, serial: true, title: true } }),
    db.inventoryItem.findFirst({ where: { organizationId: orgId, deletionRequestedAt: null, serial: { gt: item.serial } }, orderBy: { serial: "asc" }, select: { id: true, serial: true, title: true } }),
    listAssets(orgId, item.id),
  ]);
  const nav = (x: { id: string; serial: bigint; title: string } | null) => (x ? { id: x.id, lotNumber: Number(x.serial), title: x.title } : null);
  return {
    target: "item",
    item: { id: item.id, inventoryNumber: item.inventoryNumber, serial: Number(item.serial) },
    lot: { id: item.id, lotNumber: Number(item.serial), title: item.title, subtitle: item.subtitle, author: item.author, status: item.photoStatus, catalogId: item.id },
    catalog: { id: item.id, number: INVENTORY_CATALOG_NUMBER, name: "מלאי" },
    prev: nav(prev),
    next: nav(next),
    assets: assets.map(toAssetDto),
  };
}
