import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createItem } from "@/server/services/inventory";
import { createLot } from "@/server/services/lots";
import { assignToCatalog } from "@/server/services/assignments";
import { createCatalog } from "@/server/services/catalogs";
import { bulkManualMove, createLocations, createShelf, createWarehouse, createZone } from "@/server/services/warehouse";
import {
  claimNextPrintJob,
  createPrintJobs,
  createPrinter,
  createTestPrint,
  reportPrintJob,
  reprintJob,
  cancelPrintJob,
  listPrintJobs,
} from "@/server/services/printing";
import { can } from "@/server/auth/permissions";
import { hasDb, makeOrg, pairAgent } from "./helpers";

describe.skipIf(!hasDb)("quick add, catalog assignment, bulk location, print queue (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    ctx = await makeOrg("wf");
  });

  /* ───────────── one-line book entry ───────────── */
  describe("creating a book by name only", () => {
    it("gives it an inventory number, barcode and the 'awaiting photography / no location / no catalog' defaults", async () => {
      const { item, existing } = await createItem(ctx.photographer, { title: "מגילת אסתר", opId: randomUUID() });
      expect(existing).toBe(false);
      expect(item.inventoryNumber).toMatch(/^\d{8,}$/);
      expect(item.barcode).toBe(item.inventoryNumber);
      expect(item.photoStatus).toBe("NOT_STARTED");
      expect(item.currentLocationId).toBeNull();
      expect(await db.lot.count({ where: { inventoryItemId: item.id } })).toBe(0);
    });

    it("a double Enter (same opId, even concurrently) creates exactly one book", async () => {
      const opId = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => createItem(ctx.photographer, { title: "ספר כפול?", opId })));
      expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
      expect(results.filter((r) => !r.existing)).toHaveLength(1);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id, createOpId: opId } })).toBe(1);
    });

    it("different opIds are different books with strictly increasing serials", async () => {
      const a = await createItem(ctx.photographer, { title: "א", opId: randomUUID() });
      const b = await createItem(ctx.photographer, { title: "ב", opId: randomUUID() });
      expect(b.item.serial).toBeGreaterThan(a.item.serial);
    });

    it("permissions: photographers create books, viewers and warehouse staff cannot", () => {
      expect(can("PHOTOGRAPHER", "inventory.create")).toBe(true);
      expect(can("EDITOR", "inventory.create")).toBe(true);
      expect(can("VIEWER", "inventory.create")).toBe(false);
      expect(can("WAREHOUSE", "inventory.create")).toBe(false);
      expect(can("EDITOR", "inventory.delete")).toBe(false);
      expect(can("ADMIN", "inventory.delete")).toBe(true);
    });
  });

  /* ───────────── catalogs ───────────── */
  describe("assigning existing books to catalogs", () => {
    let cat1: { id: string };
    let cat2: { id: string };
    let tavinCat: { id: string };
    beforeAll(async () => {
      cat1 = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "1", name: "קטלוג 1" });
      cat2 = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "2", name: "קטלוג 2" });
      tavinCat = await createCatalog(ctx.editor, { auctionHouseId: ctx.house2.id, number: "1", name: "טבין 1" });
    });

    it("assigning an inventory book never creates a second book", async () => {
      const { item } = await createItem(ctx.editor, { title: "ספר קיים" });
      const before = await db.inventoryItem.count({ where: { organizationId: ctx.org.id } });
      const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: cat1.id });
      expect(lot.inventoryItemId).toBe(item.id);
      expect(lot.lotNumber).toBe(1);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id } })).toBe(before);
    });

    it("moving to another catalog needs the explicit flag, ends the old assignment and keeps history; no duplicate book", async () => {
      const { item } = await createItem(ctx.editor, { title: "ספר נודד" });
      await assignToCatalog(ctx.editor, item.id, { catalogId: cat1.id });
      await expect(assignToCatalog(ctx.editor, item.id, { catalogId: cat2.id })).rejects.toThrow(/כבר משויך/);
      const moved = await assignToCatalog(ctx.editor, item.id, { catalogId: tavinCat.id, replaceActive: true, endOutcome: "WITHDRAWN" });
      expect(moved.catalogId).toBe(tavinCat.id);
      const lots = await db.lot.findMany({ where: { inventoryItemId: item.id }, orderBy: { assignedAt: "asc" } });
      expect(lots.map((l) => l.assignmentStatus)).toEqual(["ENDED", "ACTIVE"]);
      expect(lots[0]!.endReason).toMatch(/טבין/);
    });

    it("refuses to move a book that is being offered, is sold, or has an open pick task", async () => {
      const offered = (await createItem(ctx.editor, { title: "מוצע" })).item;
      const l1 = await assignToCatalog(ctx.editor, offered.id, { catalogId: cat1.id });
      await db.lot.update({ where: { id: l1.id }, data: { commercialStatus: "OFFERED" } });
      await expect(assignToCatalog(ctx.editor, offered.id, { catalogId: cat2.id, replaceActive: true })).rejects.toThrow(/מוצע/);

      const sold = (await createItem(ctx.editor, { title: "נמכר" })).item;
      const l2 = await assignToCatalog(ctx.editor, sold.id, { catalogId: cat1.id });
      await db.lot.update({ where: { id: l2.id }, data: { commercialStatus: "SOLD" } });
      await expect(assignToCatalog(ctx.editor, sold.id, { catalogId: cat2.id, replaceActive: true })).rejects.toThrow(/נמכר/);

      const picking = (await createItem(ctx.editor, { title: "בליקוט" })).item;
      await assignToCatalog(ctx.editor, picking.id, { catalogId: cat1.id });
      await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: picking.id, reason: "test", status: "OPEN" } });
      await expect(assignToCatalog(ctx.editor, picking.id, { catalogId: cat2.id, replaceActive: true })).rejects.toThrow(/ליקוט/);
    });

    it("'create new book' from a catalog is idempotent on opId and also lands in inventory", async () => {
      const opId = randomUUID();
      const [a, b] = await Promise.all([createLot(ctx.photographer, cat2.id, { title: "חדש מהקטלוג", opId }), createLot(ctx.photographer, cat2.id, { title: "חדש מהקטלוג", opId })]);
      expect(a.id).toBe(b.id);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id, createOpId: opId } })).toBe(1);
      expect(await db.lot.count({ where: { catalogId: cat2.id, inventoryItemId: a.inventoryItemId } })).toBe(1);
    });
  });

  /* ───────────── warehouse placement from inventory ───────────── */
  describe("changing location from inventory (single and bulk)", () => {
    it("records every move with previous and new place, user and time; one blocked book does not stop the others", async () => {
      const wh = await createWarehouse(ctx.admin, { code: "W1", name: "מחסן 1" });
      const zone = await createZone(ctx.admin, { warehouseId: wh.id, code: "C1", name: "עמודה 1" });
      const shelf = await createShelf(ctx.admin, { zoneId: zone.id, code: "01" });
      const [loc] = await createLocations(ctx.admin, { shelfId: shelf.id, cells: ["01"] });
      const a = (await createItem(ctx.editor, { title: "מ1" })).item;
      const b = (await createItem(ctx.editor, { title: "מ2" })).item;
      const shipped = (await createItem(ctx.editor, { title: "נשלח" })).item;
      await db.inventoryItem.update({ where: { id: shipped.id }, data: { physicalStatus: "SHIPPED" } });

      const r = await bulkManualMove(ctx.warehouse, { itemIds: [a.id, b.id, shipped.id], locationId: loc!.id });
      expect(r.done.sort()).toEqual([a.id, b.id].sort());
      expect(r.failed.map((f) => f.itemId)).toEqual([shipped.id]);
      const moves = await db.inventoryLocationMovement.findMany({ where: { inventoryItemId: a.id } });
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ toLocationId: loc!.id, fromLocationId: null, userId: ctx.warehouse.userId, kind: "MANUAL" });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: a.id } })).physicalStatus).toBe("IN_STORAGE");

      // same shelf again = no new movement
      await bulkManualMove(ctx.warehouse, { itemIds: [a.id], locationId: loc!.id });
      expect(await db.inventoryLocationMovement.count({ where: { inventoryItemId: a.id } })).toBe(1);
    });
  });

  /* ───────────── print queue ───────────── */
  describe("label print queue", () => {
    let agent: Awaited<ReturnType<typeof pairAgent>>;
    let printerId: string;
    /** the queue is FIFO: finish whatever earlier tests left so each test sees its own jobs first */
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        const c = await claimNextPrintJob(agent);
        if (!c) return;
        await reportPrintJob(agent, c.jobId, { status: "DONE" });
      }
    };
    beforeAll(async () => {
      agent = await pairAgent(ctx.admin, "PRINT", "print-pc");
      printerId = (await createPrinter(ctx.admin, { name: "Zebra", connection: "NETWORK", host: "192.168.1.50", port: 9100, labelSize: "57x32", dotsPerMm: 8 })).id;
    });

    it("refuses to queue when no printer is configured", async () => {
      const other = await makeOrg("noprinter");
      const { item } = await createItem(other.admin, { title: "x" });
      await expect(createPrintJobs(other.admin, { items: [{ type: "BOOK", id: item.id }] })).rejects.toThrow(/מדפסת ראשית/);
    });

    it("a capture agent cannot use the print API, and vice versa", async () => {
      const cam = await pairAgent(ctx.admin, "CAPTURE", "cam-pc");
      await expect(claimNextPrintJob(cam)).rejects.toThrow(/סוכן הדפסה/);
    });

    it("one click → one job; a double click with the same key does not create or print twice", async () => {
      const { item } = await createItem(ctx.editor, { title: "מגילת רות — מהדורה ראשונה" });
      const key = randomUUID();
      const [j1, j2] = await Promise.all([
        createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }], idemKey: key }),
        createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }], idemKey: key }),
      ]);
      expect(j1[0]!.id).toBe(j2[0]!.id);
      expect(await db.printJob.count({ where: { organizationId: ctx.org.id, idemKey: `${key}:0` } })).toBe(1);
    });

    it("agent flow: claim renders ZPL with the stored barcode, SENT is not DONE, reports are idempotent", async () => {
      await drain();
      const { item } = await createItem(ctx.editor, { title: "תניא" });
      const [job] = await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }], copies: 2 });
      const claimed = await claimNextPrintJob(agent);
      expect(claimed).not.toBeNull();
      expect(claimed!.jobId).toBe(job!.id);
      expect(claimed!.printer).toMatchObject({ host: "192.168.1.50", port: 9100, connection: "NETWORK" });
      expect(claimed!.zpl.match(/\^XA/g)).toHaveLength(2);
      expect(claimed!.zpl).toContain(`^FD${item.barcode}^FS`);
      expect((await db.printJob.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("CLAIMED");

      // nobody else gets the same job
      expect(await claimNextPrintJob(agent)).toBeNull();

      await reportPrintJob(agent, job!.id, { status: "SENT" });
      let row = await db.printJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(row.status).toBe("SENT");
      expect(row.doneAt).toBeNull(); // never "printed" just because it was sent
      await reportPrintJob(agent, job!.id, { status: "SENT" }); // repeated report: harmless
      await reportPrintJob(agent, job!.id, { status: "DONE" });
      row = await db.printJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(row.status).toBe("DONE");
      // late/duplicate SENT after DONE cannot move it backwards
      const back = await reportPrintJob(agent, job!.id, { status: "SENT" });
      expect(back.ignored).toBe(true);
      expect((await db.printJob.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("DONE");
    });

    it("a failed job can be re-printed as a new job and a pending one can be cancelled", async () => {
      await drain();
      const { item } = await createItem(ctx.editor, { title: "כושל" });
      const [job] = await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }] });
      await claimNextPrintJob(agent);
      await reportPrintJob(agent, job!.id, { status: "FAILED", error: "המדפסת כבויה" });
      expect((await db.printer.findUniqueOrThrow({ where: { id: printerId } })).lastStatus).toBe("ERROR");
      const again = await reprintJob(ctx.editor, job!.id);
      expect(again.id).not.toBe(job!.id);
      await cancelPrintJob(ctx.editor, again.id);
      expect((await db.printJob.findUniqueOrThrow({ where: { id: again.id } })).status).toBe("CANCELLED");
      expect(await claimNextPrintJob(agent)).toBeNull();
    });

    it("a claim the agent never reported on is handed out again, then given up after 3 attempts", async () => {
      await drain();
      const { item } = await createItem(ctx.editor, { title: "תקוע" });
      const [job] = await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }] });
      for (let attempt = 1; attempt <= 3; attempt++) {
        const c = await claimNextPrintJob(agent);
        expect(c?.jobId).toBe(job!.id);
        expect(c?.attempt).toBe(attempt);
        await db.printJob.update({ where: { id: job!.id }, data: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      }
      expect(await claimNextPrintJob(agent)).toBeNull();
      const row = await db.printJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(row.status).toBe("FAILED");
    });

    it("big batches are split into jobs of at most 40 labels, in order", async () => {
      const books = [];
      for (let i = 0; i < 85; i++) books.push((await createItem(ctx.editor, { title: `אצווה ${i}` })).item.id);
      const jobs = await createPrintJobs(ctx.editor, { items: books.map((id) => ({ type: "BOOK" as const, id })), idemKey: randomUUID() });
      expect(jobs.map((j) => j.labelCount)).toEqual([40, 40, 5]);
    });

    it("column / warehouse printing expands to shelves and a column label; the test print works", async () => {
      await drain();
      const wh = await createWarehouse(ctx.admin, { code: "W2", name: "מחסן 2" });
      const zone = await createZone(ctx.admin, { warehouseId: wh.id, code: "C1", name: "עמודה 1" });
      for (const code of ["01", "02", "03"]) {
        const s = await createShelf(ctx.admin, { zoneId: zone.id, code });
        await createLocations(ctx.admin, { shelfId: s.id, cells: ["01"] });
      }
      const [job] = await createPrintJobs(ctx.admin, { zoneId: zone.id });
      expect(job!.labelCount).toBe(4); // column label + 3 shelves
      const t = await createTestPrint(ctx.admin, printerId);
      // drain both and look at the rendered ZPL
      const c1 = await claimNextPrintJob(agent);
      expect(c1!.zpl).toContain("COL-W2-C1");
      expect(c1!.zpl).toContain("LOC-W2-C1-01-01");
      const c2 = await claimNextPrintJob(agent);
      expect(c2!.jobId).toBe(t.id);
      expect((await listPrintJobs(ctx.org.id)).length).toBeGreaterThan(5);
    });
  });
});
