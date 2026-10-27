import "server-only";
import { z } from "zod";
import type { Job, Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import { storage } from "../storage";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { syncItemCommercial } from "./assignments";

/*
 * Permanent deletion — books (with every stored file) and catalogs (books stay).
 *
 * Books:   request  → blockers checked, the book is marked "deletion requested" (hidden from everyday
 *                     work) and one DELETE_ITEMS job is queued;
 *          job      → collects every storage key of the book's photos, deletes the objects (idempotent,
 *                     retried by the job worker with backoff), and only after ALL files of a book are gone
 *                     removes its rows in an explicit order (no reliance on cascades);
 *          failure  → the book stays hidden with the job in FAILED/QUEUED; the UI shows "deletion in progress".
 * Catalogs: the catalog and its assignments are removed; the books, their photos and location stay.
 *          Sold outcomes and open pick tasks are handled explicitly (see deleteCatalogRows).
 */

export const deleteRequestSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

/* ───────────────────────── books ───────────────────────── */

export interface ItemDeletePreview {
  deletable: { id: string; inventoryNumber: string; title: string }[];
  blocked: { id: string; inventoryNumber: string; title: string; reason: string }[];
  photos: number;
  files: number;
  catalogAssignments: number;
  soldAssignments: number;
}

export async function previewDeleteItems(user: UserPrincipal, ids: string[]): Promise<ItemDeletePreview> {
  const items = await db.inventoryItem.findMany({
    where: { organizationId: user.organizationId, id: { in: ids } },
    select: {
      id: true,
      inventoryNumber: true,
      title: true,
      physicalStatus: true,
      commercialStatus: true,
      deletionRequestedAt: true,
      pickTasks: { where: { status: { in: ["OPEN", "PICKED", "PACKED"] } }, select: { id: true } },
    },
  });
  if (items.length !== new Set(ids).size) throw notFound("חלק מהספרים");
  const deletable: ItemDeletePreview["deletable"] = [];
  const blocked: ItemDeletePreview["blocked"] = [];
  for (const i of items) {
    const base = { id: i.id, inventoryNumber: i.inventoryNumber, title: i.title };
    if (i.deletionRequestedAt) blocked.push({ ...base, reason: "המחיקה כבר בתהליך" });
    else if (i.pickTasks.length) blocked.push({ ...base, reason: "יש משימת ליקוט פעילה — סיימו או בטלו אותה קודם" });
    else if (i.commercialStatus === "SOLD" && i.physicalStatus !== "SHIPPED") blocked.push({ ...base, reason: "הספר נמכר וטרם נשלח" });
    else deletable.push(base);
  }
  const ok = deletable.map((d) => d.id);
  const [photos, files, lots, sold] = await Promise.all([
    db.photoAsset.count({ where: { inventoryItemId: { in: ok } } }),
    db.photoFile.count({ where: { asset: { inventoryItemId: { in: ok } } } }),
    db.lot.count({ where: { inventoryItemId: { in: ok } } }),
    db.lot.count({ where: { inventoryItemId: { in: ok }, commercialStatus: "SOLD" } }),
  ]);
  return { deletable, blocked, photos, files, catalogAssignments: lots, soldAssignments: sold };
}

/** Marks the books and queues the deletion job. Returns at once; progress is read from the job. */
export async function requestDeleteItems(user: UserPrincipal, ids: string[]) {
  const preview = await previewDeleteItems(user, ids);
  const ok = preview.deletable.map((d) => d.id);
  if (!ok.length) throw new AppError("CONFLICT", preview.blocked[0]?.reason ?? "אין ספרים למחיקה");
  const job = await db.$transaction(async (tx) => {
    // re-check inside the transaction: only books not yet marked are taken
    const marked = await tx.inventoryItem.updateMany({
      where: { organizationId: user.organizationId, id: { in: ok }, deletionRequestedAt: null },
      data: { deletionRequestedAt: new Date(), deletionRequestedById: user.userId },
    });
    if (marked.count !== ok.length) throw new AppError("CONFLICT", "חלק מהספרים כבר נמצאים במחיקה");
    return tx.job.create({
      data: { organizationId: user.organizationId, type: "DELETE_ITEMS", payload: { itemIds: ok } as Prisma.InputJsonValue, progressTotal: ok.length, createdById: user.userId },
    });
  });
  await audit(user, { action: "inventory.delete_requested", entityType: "inventory", entityId: job.id, data: { count: ok.length, jobId: job.id } });
  return { jobId: job.id, requested: ok.length, blocked: preview.blocked };
}

/** Every storage key that belongs to a book's photos. */
async function storageKeysOf(itemId: string) {
  const assets = await db.photoAsset.findMany({
    where: { inventoryItemId: itemId },
    select: { id: true, captureId: true, thumbKey: true, previewKey: true, processedKey: true, files: { select: { storageKey: true } } },
  });
  const keys = new Set<string>();
  for (const a of assets) {
    for (const f of a.files) keys.add(f.storageKey);
    for (const k of [a.thumbKey, a.previewKey, a.processedKey]) if (k) keys.add(k);
  }
  return { keys: [...keys], captureIds: assets.map((a) => a.captureId) };
}

async function deleteOneItem(job: Job, itemId: string) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: job.organizationId } });
  if (!item) return { files: 0, done: true }; // already gone — a retry after the rows were removed
  if (!item.deletionRequestedAt) throw new AppError("CONFLICT", `הספר ${item.inventoryNumber} אינו מסומן למחיקה`);
  const { keys, captureIds } = await storageKeysOf(itemId);
  const store = storage();
  const failures: string[] = [];
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (err) {
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length) throw new Error(`נכשלה מחיקת ${failures.length} קבצים של ${item.inventoryNumber} (${failures[0]})`);

  // export ZIPs that contain this book's photos are copies too
  const exports = await db.job.findMany({ where: { organizationId: job.organizationId, type: "EXPORT_ZIP", resultKey: { not: null }, payload: { path: ["inventoryItemId"], equals: itemId } }, select: { id: true, resultKey: true } });
  for (const e of exports) {
    await store.delete(e.resultKey!).catch(() => undefined);
    await db.job.update({ where: { id: e.id }, data: { resultKey: null } });
  }

  await db.$transaction(
    async (tx) => {
      await tx.pickTask.deleteMany({ where: { inventoryItemId: itemId } });
      await tx.stockCountEntry.deleteMany({ where: { inventoryItemId: itemId } });
      await tx.captureSession.updateMany({ where: { inventoryItemId: itemId }, data: { inventoryItemId: null, lotId: null } });
      // lots cascade to LotDisplayAsset / LotDescriptionVersion / LotCategoryNote
      await tx.lot.deleteMany({ where: { inventoryItemId: itemId } });
      // assets cascade to PhotoFile / LotDisplayAsset
      await tx.photoAsset.deleteMany({ where: { inventoryItemId: itemId } });
      await tx.inventoryItem.update({ where: { id: itemId }, data: { primaryAssetId: null } });
      // movements, status events, analyses and category notes cascade with the book
      await tx.inventoryItem.delete({ where: { id: itemId } });
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          userId: item.deletionRequestedById,
          action: "inventory.deleted_permanently",
          entityType: "inventory",
          entityId: itemId,
          // captureIds let a paired capture station remove its local copies (see /api/agent/deleted-captures)
          data: { inventoryNumber: item.inventoryNumber, barcode: item.barcode, title: item.title, files: keys.length, captureIds } as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 60_000 },
  );
  return { files: keys.length, done: true };
}

export async function runDeleteItemsJob(job: Job) {
  const { itemIds } = job.payload as { itemIds: string[] };
  let done = 0;
  const errors: string[] = [];
  for (const id of itemIds) {
    try {
      await deleteOneItem(job, id);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      log.error("book deletion failed", { jobId: job.id, itemId: id, err });
    }
    done++;
    await db.job.update({ where: { id: job.id }, data: { progress: done } });
  }
  // the worker retries the whole job (with backoff); books that are already gone are skipped
  if (errors.length) throw new Error(`${errors.length} ספרים לא נמחקו במלואם: ${errors[0]}`);
}

/* ───────────────────────── catalogs ───────────────────────── */

export interface CatalogDeletePreview {
  catalogs: { id: string; number: string; name: string; house: string; lots: number; activeLots: number; sold: number; offered: number }[];
  totalLots: number;
  soldLots: number;
  openPickTasks: number;
}

async function scopedCatalogs(user: UserPrincipal, ids: string[]) {
  const cats = await db.catalog.findMany({ where: { organizationId: user.organizationId, id: { in: ids } }, include: { auctionHouse: { select: { name: true } } } });
  if (cats.length !== new Set(ids).size) throw notFound("חלק מהקטלוגים");
  for (const c of cats) assertHouse(user, c.auctionHouseId);
  return cats;
}

export async function previewDeleteCatalogs(user: UserPrincipal, ids: string[]): Promise<CatalogDeletePreview> {
  const cats = await scopedCatalogs(user, ids);
  const stats = await db.lot.groupBy({ by: ["catalogId", "assignmentStatus", "commercialStatus"], where: { catalogId: { in: ids } }, _count: { _all: true } });
  const picks = await db.pickTask.count({ where: { lot: { catalogId: { in: ids } }, status: { in: ["OPEN", "PICKED", "PACKED"] } } });
  const rows = cats.map((c) => {
    const s = stats.filter((x) => x.catalogId === c.id);
    const n = (f: (x: (typeof s)[number]) => boolean) => s.filter(f).reduce((a, x) => a + x._count._all, 0);
    return {
      id: c.id,
      number: c.number,
      name: c.name,
      house: c.auctionHouse.name,
      lots: n(() => true),
      activeLots: n((x) => x.assignmentStatus === "ACTIVE"),
      sold: n((x) => x.commercialStatus === "SOLD"),
      offered: n((x) => x.commercialStatus === "OFFERED"),
    };
  });
  return { catalogs: rows, totalLots: rows.reduce((a, r) => a + r.lots, 0), soldLots: rows.reduce((a, r) => a + r.sold, 0), openPickTasks: picks };
}

export async function requestDeleteCatalogs(user: UserPrincipal, ids: string[]) {
  const preview = await previewDeleteCatalogs(user, ids);
  const job = await db.job.create({
    data: { organizationId: user.organizationId, type: "DELETE_CATALOGS", payload: { catalogIds: ids } as Prisma.InputJsonValue, progressTotal: ids.length, createdById: user.userId },
  });
  await audit(user, { action: "catalog.delete_requested", entityType: "catalog", entityId: job.id, data: { count: ids.length, lots: preview.totalLots, jobId: job.id } });
  return { jobId: job.id, requested: ids.length };
}

/**
 * One catalog, one transaction (+ status sync):
 *  - the lots (assignments) are deleted; each book stays with its photos, location and history;
 *  - a book whose deleted lot was SOLD keeps the commercial status SOLD (the sale happened — only the
 *    catalog's presentation record goes), every other book falls back to its latest remaining assignment
 *    or UNASSIGNED;
 *  - open pick tasks stay (their lot reference becomes empty; the reason text names the sale);
 *  - photos shot "for" this catalog keep existing (provenance reference is cleared by the FK).
 */
async function deleteCatalogRows(job: Job, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: job.organizationId } });
  if (!catalog) return;
  const lots = await db.lot.findMany({ where: { catalogId }, select: { id: true, inventoryItemId: true, commercialStatus: true } });
  const soldItems = new Set(lots.filter((l) => l.commercialStatus === "SOLD").map((l) => l.inventoryItemId));
  const itemIds = [...new Set(lots.map((l) => l.inventoryItemId))];
  const principal = { kind: "user", userId: job.createdById, organizationId: job.organizationId, role: "ADMIN" } as unknown as UserPrincipal;
  await db.$transaction(
    async (tx) => {
      await tx.lot.deleteMany({ where: { catalogId } });
      await tx.catalog.delete({ where: { id: catalogId } });
      for (const itemId of itemIds) {
        if (soldItems.has(itemId)) continue;
        await syncItemCommercial(tx, principal, itemId, { reason: `קטלוג ${catalog.number} נמחק` });
      }
      await tx.auditLog.create({
        data: {
          organizationId: job.organizationId,
          userId: job.createdById,
          action: "catalog.deleted_permanently",
          entityType: "catalog",
          entityId: catalogId,
          data: { number: catalog.number, name: catalog.name, lots: lots.length, sold: soldItems.size } as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 120_000 },
  );
}

export async function runDeleteCatalogsJob(job: Job) {
  const { catalogIds } = job.payload as { catalogIds: string[] };
  let done = 0;
  const errors: string[] = [];
  for (const id of catalogIds) {
    try {
      await deleteCatalogRows(job, id);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      log.error("catalog deletion failed", { jobId: job.id, catalogId: id, err });
    }
    done++;
    await db.job.update({ where: { id: job.id }, data: { progress: done } });
  }
  if (errors.length) throw new Error(`${errors.length} קטלוגים לא נמחקו: ${errors[0]}`);
}

/* ───────────────────────── catalog items (assignments) ───────────────────────── */

/**
 * Removes books from a catalog (the books themselves are never touched). Items that already carry a
 * commercial outcome are refused one by one and reported.
 */
export async function removeLotsFromCatalog(user: UserPrincipal, catalogId: string, lotIds: string[]) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const lots = await db.lot.findMany({ where: { id: { in: lotIds }, catalogId, organizationId: user.organizationId } });
  const done: string[] = [];
  const failed: { lotId: string; message: string }[] = [];
  for (const lot of lots) {
    if (lot.commercialStatus !== "ASSIGNED") {
      failed.push({ lotId: lot.id, message: `פריט ${lot.lotNumber}: יש לו מצב מסחרי — יש לסיים את השיוך, לא למחוק` });
      continue;
    }
    if (await db.pickTask.count({ where: { lotId: lot.id } })) {
      failed.push({ lotId: lot.id, message: `פריט ${lot.lotNumber}: קיימות משימות ליקוט` });
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.lot.delete({ where: { id: lot.id } });
      await syncItemCommercial(tx, user, lot.inventoryItemId, { reason: `השיוך לקטלוג ${catalog.number} הוסר` });
    });
    done.push(lot.id);
  }
  if (done.length) await audit(user, { action: "catalog.lots_removed", entityType: "catalog", entityId: catalogId, data: { count: done.length } });
  return { done, failed };
}

/* ───────────────────────── status ───────────────────────── */

/** Progress of a deletion job, plus how many of its books still wait for their files to be removed. */
export async function deletionStatus(user: UserPrincipal, jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, organizationId: user.organizationId, type: { in: ["DELETE_ITEMS", "DELETE_CATALOGS"] } } });
  if (!job) throw notFound("משימת המחיקה");
  const payload = job.payload as { itemIds?: string[]; catalogIds?: string[] };
  const remaining = job.type === "DELETE_ITEMS" ? await db.inventoryItem.count({ where: { id: { in: payload.itemIds ?? [] } } }) : await db.catalog.count({ where: { id: { in: payload.catalogIds ?? [] } } });
  const total = job.progressTotal;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    total,
    deleted: Math.max(0, total - remaining),
    remaining,
    /** "in progress" while queued/running or while the worker is still retrying failed files */
    inProgress: job.status === "QUEUED" || job.status === "RUNNING",
    error: job.error,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Station-side cleanup: capture ids of books deleted permanently since `since` (a paired station removes its local copies). */
export async function deletedCaptureIds(orgId: string, since: Date) {
  const rows = await db.auditLog.findMany({
    where: { organizationId: orgId, action: "inventory.deleted_permanently", createdAt: { gt: since } },
    select: { createdAt: true, data: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return {
    captureIds: rows.flatMap((r) => ((r.data as { captureIds?: string[] } | null)?.captureIds ?? [])),
    until: rows.at(-1)?.createdAt.toISOString() ?? since.toISOString(),
  };
}

/**
 * Safety net for the worker: a book still marked for deletion whose job finished (FAILED after its
 * retries, or lost) gets a fresh job, so "deletion in progress" always ends.
 */
export async function resumeStalledDeletions(orgId: string) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stuck = await db.inventoryItem.findMany({ where: { organizationId: orgId, deletionRequestedAt: { lt: cutoff } }, select: { id: true, deletionRequestedById: true }, take: 200 });
  if (!stuck.length) return 0;
  const active = await db.job.findMany({ where: { organizationId: orgId, type: "DELETE_ITEMS", status: { in: ["QUEUED", "RUNNING"] } }, select: { payload: true } });
  const covered = new Set(active.flatMap((j) => (j.payload as { itemIds?: string[] }).itemIds ?? []));
  const todo = stuck.filter((s) => !covered.has(s.id));
  if (!todo.length) return 0;
  await db.job.create({
    data: { organizationId: orgId, type: "DELETE_ITEMS", payload: { itemIds: todo.map((t) => t.id) } as Prisma.InputJsonValue, progressTotal: todo.length, createdById: todo[0]!.deletionRequestedById },
  });
  return todo.length;
}
