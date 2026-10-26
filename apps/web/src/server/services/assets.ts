import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@avot/shared";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { storage } from "../storage";
import { lockItem, recountItem } from "./lot-counters";
import { resolveItemTarget } from "./inventory";
import { log } from "../log";

/*
 * Source photos belong to the InventoryItem (the physical copy). A catalog lot
 * shows the item's photos; it may override their order, hide some, and pick
 * its own primary photo (LotDisplayAsset / Lot.primaryAssetId) — files are
 * never copied.
 */

export const assetPatchSchema = z.object({
  displayName: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(5000).nullish(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  crop: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) })
    .nullish(),
  needsReshoot: z.boolean().optional(),
  reshootNote: z.string().trim().max(1000).nullish(),
});

export const assetSelect = {
  id: true,
  inventoryItemId: true,
  lotId: true,
  catalogId: true,
  category: true,
  captureId: true,
  sequence: true,
  sortOrder: true,
  isPrimary: true,
  displayName: true,
  notes: true,
  rotation: true,
  crop: true,
  width: true,
  height: true,
  capturedAt: true,
  source: true,
  cameraName: true,
  thumbKey: true,
  processingStatus: true,
  imageState: true,
  processing: true,
  processingResult: true,
  processedKey: true,
  processedMime: true,
  processedWidth: true,
  processedHeight: true,
  quality: true,
  needsReshoot: true,
  reshootNote: true,
  deletedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  files: { select: { id: true, role: true, mimeType: true, extension: true, sizeBytes: true, uploadStatus: true, sha256: true, originalFilename: true } },
} as const;

async function loadAssets(user: UserPrincipal, ids: string[], opts: { includeDeleted?: boolean } = {}) {
  const assets = await db.photoAsset.findMany({
    where: { id: { in: ids }, organizationId: user.organizationId, ...(opts.includeDeleted ? {} : { deletedAt: null }) },
  });
  if (assets.length !== new Set(ids).size) throw notFound("התמונה");
  return assets;
}

/** The item's photos in master order. */
export async function listAssets(orgId: string, itemId: string, category?: PhotoCategory) {
  return db.photoAsset.findMany({
    where: { organizationId: orgId, inventoryItemId: itemId, deletedAt: null, ...(category ? { category } : {}) },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    select: assetSelect,
  });
}

/**
 * The item's photos as a given catalog lot presents them: hidden photos
 * removed, the lot's order where it set one (then the master order), and the
 * lot's primary photo (falling back to the item's). sortOrder / isPrimary of
 * the returned rows are the lot's view.
 */
export async function listLotAssets(orgId: string, lot: { id: string; inventoryItemId: string; primaryAssetId: string | null }, category?: PhotoCategory) {
  const [assets, display, item] = await Promise.all([
    listAssets(orgId, lot.inventoryItemId, category),
    db.lotDisplayAsset.findMany({ where: { lotId: lot.id } }),
    db.inventoryItem.findUnique({ where: { id: lot.inventoryItemId }, select: { primaryAssetId: true } }),
  ]);
  const byId = new Map(display.map((d) => [d.assetId, d]));
  const primary = lot.primaryAssetId ?? item?.primaryAssetId ?? null;
  const key = (a: (typeof assets)[number]) => byId.get(a.id)?.sortOrder ?? 1_000_000 + a.sortOrder;
  return PHOTO_CATEGORIES.flatMap((c) =>
    assets
      .filter((a) => a.category === c && !byId.get(a.id)?.hidden)
      .sort((x, y) => key(x) - key(y))
      .map((a, i) => ({ ...a, sortOrder: i + 1, isPrimary: a.id === primary })),
  );
}

export async function updateAsset(user: UserPrincipal, id: string, input: z.infer<typeof assetPatchSchema>) {
  const [asset] = await loadAssets(user, [id]);
  const updated = await db.photoAsset.update({
    where: { id },
    data: { ...input, crop: input.crop === undefined ? undefined : input.crop === null ? Prisma.DbNull : input.crop },
    select: assetSelect,
  });
  await audit(user, { action: "photo.updated", entityType: "asset", entityId: id, lotId: asset!.lotId, inventoryItemId: asset!.inventoryItemId, data: input as object });
  return updated;
}

export const reorderSchema = z.object({
  /** item id or lot id (legacy callers send the lot) */
  inventoryItemId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  category: z.enum(PHOTO_CATEGORIES),
  orderedIds: z.array(z.string().uuid()).max(2000),
  /** "item" (default) changes the master order; "lot" only this catalog lot's presentation */
  scope: z.enum(["item", "lot"]).optional(),
});

/** Orders the given assets (all from one item + category) as listed — master order or one lot's presentation. */
export async function reorderAssets(user: UserPrincipal, input: z.infer<typeof reorderSchema>) {
  const target = await resolveItemTarget(user.organizationId, input.inventoryItemId ?? input.lotId ?? "");
  if (!target) throw notFound("הספר");
  const lotScope = input.scope === "lot";
  if (lotScope && !target.lot) throw new AppError("VALIDATION", "סדר תצוגה לקטלוג מחייב פריט קטלוג");
  const current = await db.photoAsset.findMany({
    where: { organizationId: user.organizationId, inventoryItemId: target.itemId, category: input.category, deletedAt: null },
    select: { id: true },
  });
  const hidden = lotScope ? new Set((await db.lotDisplayAsset.findMany({ where: { lotId: target.lot!.id, hidden: true } })).map((d) => d.assetId)) : new Set<string>();
  const set = new Set(current.map((a) => a.id).filter((id) => !hidden.has(id)));
  if (input.orderedIds.length !== set.size || input.orderedIds.some((id) => !set.has(id))) {
    throw new AppError("CONFLICT", "סדר התמונות השתנה בינתיים. רעננו את הגלריה ונסו שוב.");
  }
  if (lotScope) {
    const lotId = target.lot!.id;
    await db.$transaction(
      input.orderedIds.map((assetId, i) =>
        db.lotDisplayAsset.upsert({ where: { lotId_assetId: { lotId, assetId } }, create: { lotId, assetId, sortOrder: i + 1 }, update: { sortOrder: i + 1 } }),
      ),
    );
  } else {
    await db.$transaction(input.orderedIds.map((id, i) => db.photoAsset.update({ where: { id }, data: { sortOrder: i + 1 } })));
  }
  await audit(user, {
    action: lotScope ? "photo.reordered_lot" : "photo.reordered",
    entityType: lotScope ? "lot" : "inventory",
    entityId: lotScope ? target.lot!.id : target.itemId,
    lotId: target.lot?.id ?? null,
    inventoryItemId: target.itemId,
    data: { category: input.category },
  });
}

/** Clears a lot's presentation overrides — it follows the item's master order and primary again. */
export async function resetLotDisplay(user: UserPrincipal, lotId: string) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId } });
  if (!lot) throw notFound("הפריט");
  await db.$transaction([db.lotDisplayAsset.deleteMany({ where: { lotId } }), db.lot.update({ where: { id: lotId }, data: { primaryAssetId: null } })]);
  await audit(user, { action: "photo.lot_display_reset", entityType: "lot", entityId: lotId, lotId, inventoryItemId: lot.inventoryItemId });
}

export async function setLotAssetHidden(user: UserPrincipal, lotId: string, assetId: string, hidden: boolean) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId } });
  if (!lot) throw notFound("הפריט");
  const [asset] = await loadAssets(user, [assetId]);
  if (asset!.inventoryItemId !== lot.inventoryItemId) throw new AppError("VALIDATION", "התמונה אינה של ספר זה");
  await db.$transaction(async (tx) => {
    await tx.lotDisplayAsset.upsert({ where: { lotId_assetId: { lotId, assetId } }, create: { lotId, assetId, hidden }, update: { hidden } });
    if (hidden && lot.primaryAssetId === assetId) await tx.lot.update({ where: { id: lotId }, data: { primaryAssetId: null } });
  });
  await audit(user, { action: hidden ? "photo.lot_hidden" : "photo.lot_shown", entityType: "asset", entityId: assetId, lotId, inventoryItemId: lot.inventoryItemId });
}

/**
 * Primary photo. Without `lotId` it is the item's primary (lots that simply
 * followed the previous item primary follow the new one); with `lotId` it is
 * that catalog lot's own choice.
 */
export async function setPrimary(user: UserPrincipal, assetId: string, lotId?: string | null) {
  const [asset] = await loadAssets(user, [assetId]);
  const itemId = asset!.inventoryItemId;
  if (lotId) {
    const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId } });
    if (!lot || lot.inventoryItemId !== itemId) throw new AppError("VALIDATION", "התמונה אינה של ספר זה");
    await db.lot.update({ where: { id: lotId }, data: { primaryAssetId: assetId } });
    await audit(user, { action: "photo.set_primary_lot", entityType: "asset", entityId: assetId, lotId, inventoryItemId: itemId });
    return;
  }
  await db.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { primaryAssetId: true } });
    await tx.photoAsset.updateMany({ where: { inventoryItemId: itemId, isPrimary: true }, data: { isPrimary: false } });
    await tx.photoAsset.update({ where: { id: assetId }, data: { isPrimary: true } });
    await tx.inventoryItem.update({ where: { id: itemId }, data: { primaryAssetId: assetId } });
    // lots whose primary was just "the item's primary" keep following it
    if (item.primaryAssetId) await tx.lot.updateMany({ where: { inventoryItemId: itemId, primaryAssetId: item.primaryAssetId }, data: { primaryAssetId: null } });
  });
  await audit(user, { action: "photo.set_primary", entityType: "asset", entityId: assetId, lotId: asset!.lotId, inventoryItemId: itemId });
}

export const moveSchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(500),
  /** target book — an inventory item id, or a lot id (resolved to its item) */
  targetItemId: z.string().uuid().optional(),
  targetLotId: z.string().uuid().optional(),
  targetCategory: z.enum(PHOTO_CATEGORIES),
  /** must be true when moving to a different book — the UI asks explicitly */
  confirmLotChange: z.boolean().optional(),
});

export async function moveAssets(user: UserPrincipal, input: z.infer<typeof moveSchema>) {
  const assets = await loadAssets(user, input.assetIds);
  const sourceItems = [...new Set(assets.map((a) => a.inventoryItemId))];
  const requested = input.targetItemId ?? input.targetLotId;
  const resolved = requested ? await resolveItemTarget(user.organizationId, requested) : null;
  if (requested && !resolved) throw notFound("ספר היעד");
  const targetItemId = resolved?.itemId ?? (sourceItems.length === 1 ? sourceItems[0]! : undefined);
  if (!targetItemId) throw new AppError("VALIDATION", "יש לבחור ספר יעד");
  const changesItem = sourceItems.some((i) => i !== targetItemId);
  if (changesItem && !input.confirmLotChange) throw new AppError("VALIDATION", "העברה לספר אחר מחייבת אישור מפורש");
  const targetLot = resolved?.lot ?? null;

  await db.$transaction(async (tx) => {
    await lockItem(tx, targetItemId);
    const agg = await tx.photoAsset.aggregate({ where: { inventoryItemId: targetItemId, category: input.targetCategory }, _max: { sortOrder: true } });
    const seqAgg = await tx.photoAsset.aggregate({ where: { inventoryItemId: targetItemId }, _max: { sequence: true } });
    let sort = agg._max.sortOrder ?? 0;
    let seq = seqAgg._max.sequence ?? 0;
    for (const a of [...assets].sort((x, y) => x.sortOrder - y.sortOrder)) {
      const sameItem = a.inventoryItemId === targetItemId;
      await tx.photoAsset.update({
        where: { id: a.id },
        data: {
          inventoryItemId: targetItemId,
          ...(sameItem ? {} : { lotId: targetLot?.id ?? null, catalogId: targetLot?.catalogId ?? null }),
          category: input.targetCategory,
          sortOrder: ++sort,
          // sequence numbers are per book; a moved photo gets a fresh one in its new book
          sequence: sameItem ? a.sequence : ++seq,
          isPrimary: sameItem ? a.isPrimary : false,
        },
      });
      // per-lot presentation rows of the old book no longer apply
      if (!sameItem) await tx.lotDisplayAsset.deleteMany({ where: { assetId: a.id } });
    }
    for (const itemId of new Set([...sourceItems, targetItemId])) await recountItem(tx, itemId);
  });
  for (const a of assets) {
    await audit(user, {
      action: a.inventoryItemId !== targetItemId ? "photo.moved_lot" : "photo.moved_category",
      entityType: "asset",
      entityId: a.id,
      lotId: targetLot?.id ?? null,
      inventoryItemId: targetItemId,
      data: { fromItem: a.inventoryItemId, toItem: targetItemId, fromLot: a.lotId, fromCategory: a.category, toCategory: input.targetCategory },
    });
  }
}

export async function softDeleteAssets(user: UserPrincipal, ids: string[]) {
  const assets = await loadAssets(user, ids);
  await db.$transaction(async (tx) => {
    await tx.photoAsset.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: new Date(), deletedById: user.userId, isPrimary: false },
    });
    for (const itemId of new Set(assets.map((a) => a.inventoryItemId))) await recountItem(tx, itemId);
  });
  for (const a of assets) {
    await audit(user, {
      action: "photo.deleted",
      entityType: "asset",
      entityId: a.id,
      lotId: a.lotId,
      inventoryItemId: a.inventoryItemId,
      data: { category: a.category, sequence: a.sequence },
    });
  }
}

export async function restoreAssets(user: UserPrincipal, ids: string[]) {
  const assets = await loadAssets(user, ids, { includeDeleted: true });
  await db.$transaction(async (tx) => {
    for (const a of assets) {
      // restored photos go to the end of their category so they never collide with the current order
      const agg = await tx.photoAsset.aggregate({ where: { inventoryItemId: a.inventoryItemId, category: a.category, deletedAt: null }, _max: { sortOrder: true } });
      await tx.photoAsset.update({ where: { id: a.id }, data: { deletedAt: null, deletedById: null, sortOrder: (agg._max.sortOrder ?? 0) + 1 } });
    }
    for (const itemId of new Set(assets.map((a) => a.inventoryItemId))) await recountItem(tx, itemId);
  });
  for (const a of assets) {
    await audit(user, { action: "photo.restored", entityType: "asset", entityId: a.id, lotId: a.lotId, inventoryItemId: a.inventoryItemId });
  }
}

/**
 * Permanently removes photos whose recycle-bin retention has elapsed. Called by
 * the PURGE_TRASH job only — there is no user-facing "delete forever now"
 * shortcut that bypasses the retention window.
 */
export async function purgeExpiredTrash(orgId: string, retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await db.photoAsset.findMany({
    where: { organizationId: orgId, deletedAt: { lt: cutoff } },
    include: { files: true },
    take: 200,
  });
  const store = storage();
  for (const a of expired) {
    try {
      for (const f of a.files) await store.delete(f.storageKey);
      if (a.thumbKey) await store.delete(a.thumbKey);
      if (a.previewKey) await store.delete(a.previewKey);
      if (a.processedKey) await store.delete(a.processedKey);
      await db.photoAsset.delete({ where: { id: a.id } });
      await db.auditLog.create({
        data: {
          organizationId: orgId,
          action: "photo.purged",
          entityType: "asset",
          entityId: a.id,
          lotId: a.lotId,
          inventoryItemId: a.inventoryItemId,
          data: { deletedAt: a.deletedAt },
        },
      });
    } catch (err) {
      log.error("purge failed", { assetId: a.id, err });
    }
  }
  return expired.length;
}
