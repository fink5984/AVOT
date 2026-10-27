import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { storage } from "@/server/storage";
import { createItem, listInventory } from "@/server/services/inventory";
import { assignToCatalog } from "@/server/services/assignments";
import { createCatalog } from "@/server/services/catalogs";
import {
  deletedCaptureIds,
  deletionStatus,
  previewDeleteCatalogs,
  previewDeleteItems,
  removeLotsFromCatalog,
  requestDeleteCatalogs,
  requestDeleteItems,
  resumeStalledDeletions,
  runDeleteCatalogsJob,
  runDeleteItemsJob,
} from "@/server/services/deletion";
import { can } from "@/server/auth/permissions";
import { hasDb, makeOrg } from "./helpers";

describe.skipIf(!hasDb)("permanent deletion of books and catalogs (real database, local storage)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => {
    ctx = await makeOrg("del");
  });
  afterEach(() => vi.restoreAllMocks());

  /** a book with `n` photos, each with an original, a thumbnail, a preview and a processed image on disk */
  async function bookWithPhotos(title: string, n = 2) {
    const { item } = await createItem(ctx.editor, { title });
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const base = `orgs/${ctx.org.id}/it/${item.id}/${i}`;
      const k = { orig: `${base}.jpg`, raw: `${base}.cr3`, thumb: `${base}.thumb.webp`, prev: `${base}.prev.jpg`, proc: `${base}.proc.png` };
      for (const key of Object.values(k)) await storage().putBuffer(key, Buffer.from(`bytes of ${key}`), "application/octet-stream");
      keys.push(...Object.values(k));
      const asset = await db.photoAsset.create({
        data: {
          organizationId: ctx.org.id,
          inventoryItemId: item.id,
          category: "COVER",
          captureId: randomUUID(),
          source: "SIMULATOR",
          sequence: i + 1,
          sortOrder: i,
          capturedAt: new Date(),
          thumbKey: k.thumb,
          previewKey: k.prev,
          processedKey: k.proc,
          files: {
            create: [
              { role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: 10, sha256: "0".repeat(64), storageKey: k.orig, uploadStatus: "VERIFIED" },
              { role: "RAW", originalFilename: "a.cr3", mimeType: "image/x-canon-cr3", extension: "cr3", sizeBytes: 10, sha256: "1".repeat(64), storageKey: k.raw, uploadStatus: "VERIFIED" },
            ],
          },
        },
      });
      if (i === 0) await db.inventoryItem.update({ where: { id: item.id }, data: { primaryAssetId: asset.id, photoCount: n } });
    }
    return { item, keys };
  }
  const jobOf = (id: string) => db.job.findUniqueOrThrow({ where: { id } });
  const allGone = async (keys: string[]) => (await Promise.all(keys.map((k) => storage().exists(k)))).every((e) => !e);

  it("only the permitted role may delete (server-side matrix)", () => {
    expect(can("ADMIN", "inventory.delete")).toBe(true);
    for (const r of ["EDITOR", "PHOTOGRAPHER", "WAREHOUSE", "VIEWER"] as const) expect(can(r, "inventory.delete")).toBe(false);
    expect(can("ADMIN", "catalog.delete")).toBe(true);
    expect(can("EDITOR", "catalog.delete")).toBe(false);
  });

  it("deletes the book, its photos and every stored file (original, RAW, thumb, preview, processed) — and leaves other books alone", async () => {
    const a = await bookWithPhotos("למחיקה");
    const b = await bookWithPhotos("נשאר");
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "D1", name: "קטלוג למחיקה" });
    await assignToCatalog(ctx.editor, a.item.id, { catalogId: catalog.id });

    const preview = await previewDeleteItems(ctx.admin, [a.item.id]);
    expect(preview).toMatchObject({ photos: 2, files: 4, catalogAssignments: 1 });

    const { jobId, requested } = await requestDeleteItems(ctx.admin, [a.item.id]);
    expect(requested).toBe(1);
    // hidden from everyday work immediately, still in the database until its files are gone
    expect((await listInventory(ctx.admin, { q: "למחיקה" })).items).toHaveLength(0);
    expect(await db.inventoryItem.count({ where: { id: a.item.id } })).toBe(1);
    expect(await deletionStatus(ctx.admin, jobId)).toMatchObject({ inProgress: true, remaining: 1 });

    await runDeleteItemsJob(await jobOf(jobId));
    await db.job.update({ where: { id: jobId }, data: { status: "SUCCEEDED" } });

    expect(await allGone(a.keys)).toBe(true);
    expect(await db.inventoryItem.count({ where: { id: a.item.id } })).toBe(0);
    expect(await db.photoAsset.count({ where: { inventoryItemId: a.item.id } })).toBe(0);
    expect(await db.lot.count({ where: { inventoryItemId: a.item.id } })).toBe(0);
    expect(await db.catalog.count({ where: { id: catalog.id } })).toBe(1); // deleting a book never deletes its catalog
    // the neighbour is untouched
    expect(await allGone(b.keys)).toBe(false);
    expect(await db.photoAsset.count({ where: { inventoryItemId: b.item.id } })).toBe(2);
    // audit trail with the capture ids stations need
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "inventory.deleted_permanently", entityId: a.item.id } });
    expect(log.data).toMatchObject({ inventoryNumber: a.item.inventoryNumber, files: 10 });
    const stations = await deletedCaptureIds(ctx.org.id, new Date(Date.now() - 60_000));
    expect(stations.captureIds).toHaveLength(2);
    expect(await deletionStatus(ctx.admin, jobId)).toMatchObject({ inProgress: false, remaining: 0, deleted: 1 });
  });

  it("a storage failure leaves the book hidden and in the database; the retry finishes the job", async () => {
    const a = await bookWithPhotos("כשל באחסון", 1);
    const { jobId } = await requestDeleteItems(ctx.admin, [a.item.id]);
    const del = storage().delete.bind(storage());
    let failures = 2;
    vi.spyOn(storage(), "delete").mockImplementation(async (key: string) => {
      if (failures-- > 0) throw new Error("R2 timeout");
      return del(key);
    });
    await expect(runDeleteItemsJob(await jobOf(jobId))).rejects.toThrow(/לא נמחקו במלואם/);
    expect(await db.inventoryItem.count({ where: { id: a.item.id } })).toBe(1); // rows kept: nothing orphaned
    expect((await listInventory(ctx.admin, { q: "כשל באחסון" })).items).toHaveLength(0);
    await runDeleteItemsJob(await jobOf(jobId)); // the worker's retry
    expect(await db.inventoryItem.count({ where: { id: a.item.id } })).toBe(0);
    expect(await allGone(a.keys)).toBe(true);
  });

  it("a lost job is recreated by the safety net so 'deletion in progress' always ends", async () => {
    const a = await bookWithPhotos("נשכח", 1);
    await requestDeleteItems(ctx.admin, [a.item.id]);
    await db.job.updateMany({ where: { organizationId: ctx.org.id, type: "DELETE_ITEMS" }, data: { status: "FAILED" } });
    await db.inventoryItem.update({ where: { id: a.item.id }, data: { deletionRequestedAt: new Date(Date.now() - 30 * 60 * 1000) } });
    expect(await resumeStalledDeletions(ctx.org.id)).toBe(1);
    const fresh = await db.job.findFirstOrThrow({ where: { organizationId: ctx.org.id, type: "DELETE_ITEMS", status: "QUEUED" } });
    await runDeleteItemsJob(fresh);
    expect(await db.inventoryItem.count({ where: { id: a.item.id } })).toBe(0);
  });

  it("refuses books with an open pick task or a sale awaiting shipment; a double request is refused", async () => {
    const picking = (await createItem(ctx.editor, { title: "בליקוט" })).item;
    await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: picking.id, reason: "x", status: "OPEN" } });
    const sold = (await createItem(ctx.editor, { title: "נמכר לא נשלח" })).item;
    await db.inventoryItem.update({ where: { id: sold.id }, data: { commercialStatus: "SOLD" } });
    const p = await previewDeleteItems(ctx.admin, [picking.id, sold.id]);
    expect(p.blocked.map((b) => b.id).sort()).toEqual([picking.id, sold.id].sort());
    await expect(requestDeleteItems(ctx.admin, [picking.id, sold.id])).rejects.toThrow();
    expect(await db.inventoryItem.count({ where: { id: { in: [picking.id, sold.id] }, deletionRequestedAt: null } })).toBe(2);

    const ok = (await createItem(ctx.editor, { title: "כפול" })).item;
    await requestDeleteItems(ctx.admin, [ok.id]);
    await expect(requestDeleteItems(ctx.admin, [ok.id])).rejects.toThrow();
  });

  it("ids from another organization are never deleted", async () => {
    const other = await makeOrg("del-other");
    const theirs = (await createItem(other.editor, { title: "של ארגון אחר" })).item;
    await expect(previewDeleteItems(ctx.admin, [theirs.id])).rejects.toThrow();
    await expect(requestDeleteItems(ctx.admin, [theirs.id])).rejects.toThrow();
    expect(await db.inventoryItem.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("bulk: 150 books with photos are deleted by one job with progress", async () => {
    const ids: string[] = [];
    const keys: string[] = [];
    for (let i = 0; i < 150; i++) {
      const { item } = await createItem(ctx.editor, { title: `המוני ${i}` });
      const key = `orgs/${ctx.org.id}/it-bulk/${item.id}.jpg`;
      await storage().putBuffer(key, Buffer.from("x"), "image/jpeg");
      await db.photoAsset.create({
        data: {
          organizationId: ctx.org.id, inventoryItemId: item.id, category: "COVER", captureId: randomUUID(), source: "SIMULATOR", sequence: 1, sortOrder: 0, capturedAt: new Date(),
          files: { create: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: 1, sha256: "2".repeat(64), storageKey: key, uploadStatus: "VERIFIED" }] },
        },
      });
      ids.push(item.id);
      keys.push(key);
    }
    const { jobId } = await requestDeleteItems(ctx.admin, ids);
    await runDeleteItemsJob(await jobOf(jobId));
    expect((await jobOf(jobId)).progress).toBe(150);
    expect(await db.inventoryItem.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await allGone(keys)).toBe(true);
  });

  describe("catalogs", () => {
    it("deleting a catalog with books removes the catalog and its assignments only; books and photos stay; sold keeps SOLD", async () => {
      const cat = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "DC1", name: "למחיקה עם ספרים" });
      const other = await createCatalog(ctx.editor, { auctionHouseId: ctx.house2.id, number: "DC2", name: "נשאר" });
      const plain = await bookWithPhotos("פשוט", 1);
      const sold = await bookWithPhotos("נמכר", 1);
      const alsoElsewhere = await bookWithPhotos("היסטוריה", 1);
      await assignToCatalog(ctx.editor, plain.item.id, { catalogId: cat.id });
      const soldLot = await assignToCatalog(ctx.editor, sold.item.id, { catalogId: cat.id });
      await db.lot.update({ where: { id: soldLot.id }, data: { commercialStatus: "SOLD", assignmentStatus: "ENDED", endedAt: new Date() } });
      await db.inventoryItem.update({ where: { id: sold.item.id }, data: { commercialStatus: "SOLD", physicalStatus: "SHIPPED" } });
      await assignToCatalog(ctx.editor, alsoElsewhere.item.id, { catalogId: cat.id });
      await assignToCatalog(ctx.editor, alsoElsewhere.item.id, { catalogId: other.id, replaceActive: true, endOutcome: "WITHDRAWN" });
      await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: sold.item.id, lotId: soldLot.id, reason: "נמכר", status: "SHIPPED" } });

      const pv = await previewDeleteCatalogs(ctx.admin, [cat.id]);
      expect(pv).toMatchObject({ totalLots: 3, soldLots: 1 });

      const { jobId } = await requestDeleteCatalogs(ctx.admin, [cat.id]);
      await runDeleteCatalogsJob(await jobOf(jobId));

      expect(await db.catalog.count({ where: { id: cat.id } })).toBe(0);
      expect(await db.lot.count({ where: { catalogId: cat.id } })).toBe(0);
      for (const b of [plain, sold, alsoElsewhere]) {
        expect(await db.inventoryItem.count({ where: { id: b.item.id } })).toBe(1);
        expect(await db.photoAsset.count({ where: { inventoryItemId: b.item.id } })).toBe(1);
        expect(await allGone(b.keys)).toBe(false);
      }
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: plain.item.id } })).commercialStatus).toBe("UNASSIGNED");
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: sold.item.id } })).commercialStatus).toBe("SOLD");
      // the book that also has an active assignment in the other catalog keeps it
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: alsoElsewhere.item.id } })).commercialStatus).toBe("ASSIGNED");
      expect(await db.lot.count({ where: { catalogId: other.id } })).toBe(1);
      // the shipped pick task survived with its history
      expect((await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: sold.item.id } })).lotId).toBeNull();
      expect(await db.auditLog.count({ where: { action: "catalog.deleted_permanently", entityId: cat.id } })).toBe(1);
    });

    it("removing items from a catalog never touches the books; items with a sale outcome are refused one by one", async () => {
      const cat = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "DC3", name: "הסרה" });
      const a = (await createItem(ctx.editor, { title: "להסרה" })).item;
      const b = (await createItem(ctx.editor, { title: "מוצע" })).item;
      const la = await assignToCatalog(ctx.editor, a.id, { catalogId: cat.id });
      const lb = await assignToCatalog(ctx.editor, b.id, { catalogId: cat.id });
      await db.lot.update({ where: { id: lb.id }, data: { commercialStatus: "OFFERED" } });
      const r = await removeLotsFromCatalog(ctx.editor, cat.id, [la.id, lb.id]);
      expect(r.done).toEqual([la.id]);
      expect(r.failed.map((f) => f.lotId)).toEqual([lb.id]);
      expect(await db.inventoryItem.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);
    });
  });
});
