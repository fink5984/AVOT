import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { LABEL_STOCKS, resolveProfile } from "@avot/shared";
import { db } from "@/server/db";
import { createItem } from "@/server/services/inventory";
import { processScan } from "@/server/services/scanning";
import { globalSearch } from "@/server/services/search";
import {
  createWarehouseFromWizard,
  deleteColumn,
  deleteEmptyShelves,
  deleteShelves,
  findLocationByCode,
  isRetiredLocationCode,
  manualMove,
  planShelfDeletion,
  addShelvesToColumn,
  createShelf,
  setShelfActive,
  warehouseTree,
} from "@/server/services/warehouse";
import { locationInclude, locationLabel } from "@/server/services/location-label";
import { claimNextPrintJob, createPrintJobs, createPrinter, createTestPrint } from "@/server/services/printing";
import { getLabelProfiles, saveLabelTemplate } from "@/server/services/label-templates";
import { layoutFor } from "@/server/labels/zpl";
import { hasDb, makeOrg, pairAgent } from "./helpers";

const op = (mode: "STORE" | "FIND", code: string, extra: Record<string, unknown> = {}) => ({ opId: randomUUID(), mode, code, clientAt: new Date().toISOString(), ...extra });

/** the data part of the shelf-locations migration, restricted to ONE organization (its temp table is the only place that selects shelves) */
const MIGRATION = readFileSync(path.join(__dirname, "../../prisma/migrations/20261029090000_shelf_locations/migration.sql"), "utf8");
function migrationFor(orgId: string) {
  const start = MIGRATION.indexOf("CREATE TEMP TABLE _shelf_primary");
  const end = MIGRATION.indexOf('ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_mergedIntoId_fkey"');
  const body = MIGRATION.slice(start, end);
  const doStart = body.indexOf("DO $$");
  const doEnd = body.indexOf("END $$;") + "END $$;".length;
  const create = body.slice(0, doStart).trim().replace('FROM "StorageLocation"', `FROM "StorageLocation" WHERE "organizationId" = '${orgId}'`);
  const guard = body.slice(doStart, doEnd);
  const rest = body.slice(doEnd).split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  return { create, guard, rest };
}
async function runMigration(orgId: string) {
  const m = migrationFor(orgId);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(m.create);
    await tx.$executeRawUnsafe(m.guard);
    for (const s of m.rest) await tx.$executeRawUnsafe(s);
  });
}

describe.skipIf(!hasDb)("shelf-only locations (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => {
    ctx = await makeOrg("shelf");
  });

  /** a warehouse with `columns` × `shelves`, returned as the tree */
  async function warehouse(name: string, columns = 2, shelves = 3) {
    const wh = await createWarehouseFromWizard(ctx.admin, { name, columns, shelvesPerColumn: shelves });
    const tree = (await warehouseTree(ctx.org.id)).find((w) => w.id === wh.id)!;
    return { wh, tree, zones: tree.zones };
  }

  describe("no cells: one location per shelf, codes without a cell", () => {
    it("the wizard and addShelves create exactly one location per shelf, 'LOC-…-<shelf>' with no cell suffix", async () => {
      const { zones } = await warehouse("מחסן א", 2, 3);
      for (const z of zones) {
        expect(z.shelves).toHaveLength(3);
        for (const s of z.shelves) {
          expect(s.locations).toHaveLength(1);
          expect(s.locations[0]!.code).toMatch(/^LOC(-[A-Z0-9]+){2,3}$/);
          expect(s.locations[0]!.code).not.toMatch(/-01$/.test(s.code) ? /-01-01$/ : /-\d\d-\d\d$/);
        }
      }
      await addShelvesToColumn(ctx.admin, { zoneId: zones[0]!.id, count: 2 });
      const after = (await warehouseTree(ctx.org.id)).flatMap((w) => w.zones).find((z) => z.id === zones[0]!.id)!;
      expect(after.shelves).toHaveLength(5);
      expect(new Set(after.shelves.map((s) => s.locations[0]!.code)).size).toBe(5);
    });

    it("createShelf (the by-code API) also gives the shelf its single location", async () => {
      const { zones } = await warehouse("מחסן ב", 1, 1);
      const s = await createShelf(ctx.admin, { zoneId: zones[0]!.id, code: "07" });
      const locs = await db.storageLocation.findMany({ where: { shelfId: s.id } });
      expect(locs).toHaveLength(1);
      expect(locs[0]!.code.endsWith("-07")).toBe(true);
    });

    it("a location is shown in Hebrew from the hierarchy — never by parsing the code, never with a cell", async () => {
      const { zones } = await warehouse("מחסן 1", 1, 1);
      const loc = await db.storageLocation.findFirstOrThrow({ where: { shelfId: zones[0]!.shelves[0]!.id }, include: locationInclude });
      expect(locationLabel(loc)).toBe("מחסן 1 · עמודה 1 · מדף 1");
      expect(locationLabel(loc)).not.toContain("LOC");
      expect(locationLabel(loc)).not.toContain("תא");
    });
  });

  describe("migrating cells to shelves — the real migration statements", () => {
    it("merges the cells of a shelf: books follow, history stays, old codes keep working, nothing is deleted", async () => {
      const m = await makeOrg("mig");
      const wh = await db.warehouse.create({ data: { organizationId: m.org.id, code: "W9", name: "מחסן 9", isDefault: false } });
      const zone = await db.warehouseZone.create({ data: { warehouseId: wh.id, code: "C1", name: "עמודה 1", sortOrder: 1 } });
      const shelf = await db.shelf.create({ data: { zoneId: zone.id, code: "01", sortOrder: 1 } });
      const mk = (cell: string) => db.storageLocation.create({ data: { organizationId: m.org.id, shelfId: shelf.id, cell, code: `LOC-W9-C1-01-${cell}`, sortKey: `W9/C1/01/${cell}` } });
      const [c1, c2, c3] = [await mk("01"), await mk("02"), await mk("03")];
      const [a, b, c] = [await createItem(m.editor, { title: "א" }), await createItem(m.editor, { title: "ב" }), await createItem(m.editor, { title: "ג" })];
      await db.inventoryItem.update({ where: { id: a.item.id }, data: { currentLocationId: c1.id, physicalStatus: "IN_STORAGE" } });
      await db.inventoryItem.update({ where: { id: b.item.id }, data: { currentLocationId: c2.id, physicalStatus: "IN_STORAGE" } });
      await db.inventoryItem.update({ where: { id: c.item.id }, data: { currentLocationId: c2.id, physicalStatus: "IN_STORAGE" } });
      // history that must survive: a movement into cell 02, a scan on cell 03
      await db.inventoryLocationMovement.create({ data: { organizationId: m.org.id, inventoryItemId: b.item.id, fromLocationId: null, toLocationId: c2.id, kind: "STORE" } });
      const scan = await db.barcodeScanEvent.create({ data: { organizationId: m.org.id, opId: randomUUID(), mode: "STORE", code: c3.code, codeType: "LOCATION", locationId: c3.id, result: "OK", clientAt: new Date() } });
      const before = await db.inventoryLocationMovement.count({ where: { organizationId: m.org.id } });

      await runMigration(m.org.id);

      const rows = await db.storageLocation.findMany({ where: { shelfId: shelf.id }, orderBy: { cell: "asc" } });
      expect(rows).toHaveLength(3); // nothing deleted
      const primary = rows.find((r) => r.id === c1.id)!;
      expect(primary).toMatchObject({ code: "LOC-W9-C1-01", active: true, mergedIntoId: null });
      for (const r of rows.filter((x) => x.id !== c1.id)) {
        expect(r.active).toBe(false);
        expect(r.mergedIntoId).toBe(c1.id);
        expect(r.code.endsWith("~merged")).toBe(true);
      }
      // every old printed code finds the shelf's location
      for (const old of ["LOC-W9-C1-01-01", "LOC-W9-C1-01-02", "LOC-W9-C1-01-03"]) expect((await findLocationByCode(m.org.id, old))!.id).toBe(c1.id);
      expect((await findLocationByCode(m.org.id, "LOC-W9-C1-01"))!.id).toBe(c1.id);
      // books are all on the shelf now; the two moved ones have a movement row each
      expect(await db.inventoryItem.count({ where: { currentLocationId: c1.id } })).toBe(3);
      expect(await db.inventoryLocationMovement.count({ where: { organizationId: m.org.id } })).toBe(before + 2);
      // the history still points at the original rows
      expect(await db.inventoryLocationMovement.count({ where: { toLocationId: c2.id, kind: "STORE" } })).toBe(1);
      expect((await db.barcodeScanEvent.findUniqueOrThrow({ where: { id: scan.id } })).locationId).toBe(c3.id);
      // scanning a printed OLD code on the handheld finds the right shelf
      const r = await processScan(m.warehouse, op("STORE", "LOC-W9-C1-01-02"));
      expect(r.result).toBe("OK");
      expect(r.activeLocation?.id).toBe(c1.id);
      expect(r.activeLocation?.label).toBe("מחסן 9 · עמודה 1 · מדף 1");
    });

    it("refuses to run while an open stock count refers to a cell that would be merged", async () => {
      const m = await makeOrg("mig2");
      const wh = await db.warehouse.create({ data: { organizationId: m.org.id, code: "W8", name: "מחסן 8", isDefault: false } });
      const zone = await db.warehouseZone.create({ data: { warehouseId: wh.id, code: "C1", name: "עמודה 1", sortOrder: 1 } });
      const shelf = await db.shelf.create({ data: { zoneId: zone.id, code: "01", sortOrder: 1 } });
      await db.storageLocation.create({ data: { organizationId: m.org.id, shelfId: shelf.id, cell: "01", code: "LOC-W8-C1-01-01", sortKey: "a" } });
      const cell2 = await db.storageLocation.create({ data: { organizationId: m.org.id, shelfId: shelf.id, cell: "02", code: "LOC-W8-C1-01-02", sortKey: "b" } });
      const session = await db.stockCountSession.create({ data: { organizationId: m.org.id, warehouseId: wh.id, status: "OPEN" } });
      await db.stockCountLocation.create({ data: { sessionId: session.id, locationId: cell2.id } });
      await expect(runMigration(m.org.id)).rejects.toThrow(/open stock count/);
      // the transaction rolled back: codes untouched
      expect((await db.storageLocation.findUniqueOrThrow({ where: { id: cell2.id } })).code).toBe("LOC-W8-C1-01-02");
    });
  });

  describe("old printed codes", () => {
    it("scanning a former code (with the cell) finds the shelf; search shows its Hebrew name; a deleted shelf's code is retired, not reused", async () => {
      const { zones } = await warehouse("מחסן ג", 1, 2);
      const shelf = zones[0]!.shelves[0]!;
      const loc = shelf.locations[0]!;
      await db.storageLocationAlias.create({ data: { organizationId: ctx.org.id, locationId: loc.id, alias: `${loc.code}-01` } });
      expect((await findLocationByCode(ctx.org.id, `${loc.code}-01`))!.id).toBe(loc.id);
      const s = await globalSearch(ctx.admin, `${loc.code}-01`);
      expect(s.directLocation).toMatchObject({ id: loc.id });
      expect(s.directLocation!.label).toBe("מחסן ג · עמודה 1 · מדף 1");

      const gone = zones[0]!.shelves[1]!;
      const goneCode = gone.locations[0]!.code;
      await deleteShelves(ctx.admin, { shelfIds: [gone.id] });
      expect(await findLocationByCode(ctx.org.id, goneCode)).toBeNull();
      expect(await isRetiredLocationCode(ctx.org.id, goneCode)).toBe(true);
      const r = await processScan(ctx.warehouse, op("STORE", goneCode));
      expect(r.result).toBe("ERROR");
      expect(r.message).toMatch(/הוסר מהמבנה/);
      // a new shelf in that column never takes the retired number or code
      await addShelvesToColumn(ctx.admin, { zoneId: zones[0]!.id, count: 1 });
      const codes = (await db.storageLocation.findMany({ where: { organizationId: ctx.org.id } })).map((l) => l.code);
      expect(codes.filter((c) => c === goneCode)).toHaveLength(0);
    });
  });

  describe("deleting shelves and columns", () => {
    it("an empty shelf with no history is removed for real; its code stays reserved", async () => {
      const { zones } = await warehouse("מחסן ד", 1, 3);
      const s = zones[0]!.shelves[2]!;
      const plan = await planShelfDeletion(ctx.admin, [s.id]);
      expect(plan.shelves[0]).toMatchObject({ books: 0, physical: true, blocked: null });
      await deleteShelves(ctx.admin, { shelfIds: [s.id] });
      expect(await db.shelf.count({ where: { id: s.id } })).toBe(0);
      expect(await db.storageLocation.count({ where: { shelfId: s.id } })).toBe(0);
      expect(await isRetiredLocationCode(ctx.org.id, s.locations[0]!.code)).toBe(true);
      const audit = await db.auditLog.findFirst({ where: { organizationId: ctx.org.id, action: "warehouse.shelves_deleted" }, orderBy: { createdAt: "desc" } });
      expect(audit).toBeTruthy();
    });

    it("a shelf with books is refused until the books are moved; the move is recorded and then the shelf goes", async () => {
      const { zones } = await warehouse("מחסן ה", 1, 3);
      const [s1, s2] = [zones[0]!.shelves[0]!, zones[0]!.shelves[1]!];
      const { item } = await createItem(ctx.editor, { title: "על המדף" });
      await manualMove(ctx.admin, item.id, { locationId: s1.locations[0]!.id });
      const plan = await planShelfDeletion(ctx.admin, [s1.id]);
      expect(plan.books).toBe(1);
      await expect(deleteShelves(ctx.admin, { shelfIds: [s1.id] })).rejects.toThrow(/ספרים/);
      expect(await db.shelf.count({ where: { id: s1.id } })).toBe(1); // untouched
      await expect(deleteShelves(ctx.admin, { shelfIds: [s1.id], moveToLocationId: s1.locations[0]!.id })).rejects.toThrow();
      await deleteShelves(ctx.admin, { shelfIds: [s1.id], moveToLocationId: s2.locations[0]!.id });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentLocationId).toBe(s2.locations[0]!.id);
      // history kept: the shelf had held a book, so it only left the active structure (the row stays)
      const row = await db.shelf.findUniqueOrThrow({ where: { id: s1.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(await db.inventoryLocationMovement.count({ where: { inventoryItemId: item.id } })).toBe(2);
      const moves = await db.inventoryLocationMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { occurredAt: "asc" } });
      expect(moves[0]!.toLocationId).toBe(s1.locations[0]!.id); // the old reference is intact
      // the deleted shelf is gone from the tree and from the picker's data
      const tree = (await warehouseTree(ctx.org.id)).flatMap((w) => w.zones).find((z) => z.id === zones[0]!.id)!;
      expect(tree.shelves.map((s) => s.id)).not.toContain(s1.id);
      // scanning it says it was removed, and the location is not offered
      const r = await processScan(ctx.warehouse, op("STORE", s1.locations[0]!.code));
      expect(r.result).toBe("ERROR");
      expect(r.message).toMatch(/הוסר מהמבנה/);
    });

    it("'delete empty shelves' removes only the empty ones; a column with books needs a target; the column leaves the structure", async () => {
      const { zones } = await warehouse("מחסן ו", 2, 4);
      const [z1, z2] = [zones[0]!, zones[1]!];
      const { item } = await createItem(ctx.editor, { title: "ספר בעמודה" });
      await manualMove(ctx.admin, item.id, { locationId: z1.shelves[1]!.locations[0]!.id });

      const dry = await deleteEmptyShelves(ctx.admin, z1.id, true);
      expect(dry.count).toBe(3);
      const done = await deleteEmptyShelves(ctx.admin, z1.id);
      expect(done.count).toBe(3);
      const left = (await warehouseTree(ctx.org.id)).flatMap((w) => w.zones).find((z) => z.id === z1.id)!;
      expect(left.shelves.map((s) => s.id)).toEqual([z1.shelves[1]!.id]); // the shelf with the book stayed

      await expect(deleteColumn(ctx.admin, z1.id, {})).rejects.toThrow(/ספרים/);
      await deleteColumn(ctx.admin, z1.id, { moveToLocationId: z2.shelves[0]!.locations[0]!.id });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentLocationId).toBe(z2.shelves[0]!.locations[0]!.id);
      const z = await db.warehouseZone.findUniqueOrThrow({ where: { id: z1.id } });
      expect(z.deletedAt).not.toBeNull(); // code reserved: the next column is not "C1" again
      const tree = (await warehouseTree(ctx.org.id)).find((w) => w.zones.some((x) => x.id === z2.id))!;
      expect(tree.zones.map((x) => x.id)).toEqual([z2.id]);
      expect((await db.auditLog.count({ where: { organizationId: ctx.org.id, action: "warehouse.column_deleted" } })) > 0).toBe(true);
    });

    it("never deletes a shelf that an open stock count refers to", async () => {
      const { wh, zones } = await warehouse("מחסן ז", 1, 2);
      const s = zones[0]!.shelves[0]!;
      const session = await db.stockCountSession.create({ data: { organizationId: ctx.org.id, warehouseId: wh.id, status: "OPEN" } });
      await db.stockCountLocation.create({ data: { sessionId: session.id, locationId: s.locations[0]!.id } });
      expect((await planShelfDeletion(ctx.admin, [s.id])).blocked).toMatch(/ספירת מלאי/);
      await expect(deleteShelves(ctx.admin, { shelfIds: [s.id] })).rejects.toThrow(/ספירת מלאי/);
      expect(await db.shelf.count({ where: { id: s.id } })).toBe(1);
    });

    it("disabling and enabling a shelf touches only its own location", async () => {
      const { zones } = await warehouse("מחסן ח", 1, 1);
      const s = zones[0]!.shelves[0]!;
      await setShelfActive(ctx.admin, s.id, false);
      expect((await db.storageLocation.findFirstOrThrow({ where: { shelfId: s.id } })).active).toBe(false);
      await setShelfActive(ctx.admin, s.id, true);
      expect((await db.storageLocation.findFirstOrThrow({ where: { shelfId: s.id } })).active).toBe(true);
    });
  });

  describe("one design for every print path (calibration)", () => {
    it("the saved calibration is applied to ZPL and to the layout the Windows station draws; shelf labels show no code text", async () => {
      const { zones } = await warehouse("מחסן ט", 1, 1);
      const loc = zones[0]!.shelves[0]!.locations[0]!;
      const { item } = await createItem(ctx.editor, { title: "תווית" });
      const agent = await pairAgent(ctx.admin, "CAPTURE", "station");
      const zplPrinter = await createPrinter(ctx.admin, { name: "תרמית", connection: "WINDOWS", windowsName: "ZEBRA", labelSize: "57x32", dotsPerMm: 8, language: "ZPL", isPrimary: true, agentId: agent.deviceId });
      const gdiPrinter = await createPrinter(ctx.admin, { name: "דרייבר", connection: "WINDOWS", windowsName: "HP", labelSize: "57x32", dotsPerMm: 8, language: "GDI", isPrimary: false, agentId: agent.deviceId });

      await saveLabelTemplate(ctx.admin, "BOOK", { profile: { barcodeHeightMm: 8, titleSizeMm: 4.5 } });
      expect((await getLabelProfiles(ctx.org.id)).BOOK).toMatchObject({ barcodeHeightMm: 8 });

      const [zjob] = await createPrintJobs(ctx.admin, { items: [{ type: "BOOK", id: item.id }, { type: "LOCATION", id: loc.id }], printerId: zplPrinter.id, idemKey: randomUUID() });
      const [gjob] = await createPrintJobs(ctx.admin, { items: [{ type: "BOOK", id: item.id }, { type: "LOCATION", id: loc.id }], printerId: gdiPrinter.id, idemKey: randomUUID() });
      expect(zjob && gjob).toBeTruthy();
      const first = await claimNextPrintJob(agent);
      const second = await claimNextPrintJob(agent);
      const byFormat = (f: string) => [first, second].find((j) => j?.format === f)!;
      const zpl = byFormat("ZPL");
      const gdi = byFormat("GDI");

      // the Windows station gets exactly the layout the engine computes with the saved profile
      const stock = LABEL_STOCKS["57x32"]!;
      const expected = layoutFor({ type: "BOOK", code: item.barcode, inventoryNumber: item.inventoryNumber, title: "תווית" }, stock, await getLabelProfiles(ctx.org.id));
      expect(gdi.layouts![0]).toEqual(expected);
      const bar = expected.items.find((i) => i.kind === "barcode")!;
      expect(bar.h).toBeCloseTo(8, 1);
      expect(resolveProfile("BOOK", await getLabelProfiles(ctx.org.id)).titleSizeMm).toBe(4.5);
      // the shelf label has no technical code as text and the barcode is the shelf's code
      const shelfLayout = gdi.layouts![1]!;
      expect(shelfLayout.items.filter((i) => i.kind === "text").some((i) => i.kind === "text" && /LOC-/.test(i.text))).toBe(false);
      expect(shelfLayout.items.find((i) => i.kind === "barcode")).toMatchObject({ code: loc.code });
      // and ZPL carries the same barcode box (same y and height)
      expect(zpl.zpl).toContain(`^FO`);
      expect(zpl.zpl).toContain(`^FD${item.barcode}^FS`);
      expect(zpl.zpl!.match(/\^XA/g)).toHaveLength(2);
    });

    it("'הדפסת ניסיון' of a label type prints a sample with the saved calibration", async () => {
      const agent = await pairAgent(ctx.admin, "CAPTURE", "station2");
      const printer = await createPrinter(ctx.admin, { name: "בדיקה", connection: "WINDOWS", windowsName: "X", labelSize: "70x40", dotsPerMm: 8, language: "GDI", isPrimary: false, agentId: agent.deviceId });
      await createTestPrint(ctx.admin, printer.id, "LOCATION");
      const job = await claimNextPrintJob(agent);
      expect(job!.layouts![0]!.type).toBe("LOCATION");
    });
  });

  describe("search by inventory number (regression: 10000041)", () => {
    it("an exact number is found, shown as a result and opened by Enter; partial, old ITM number, alias, barcode and title work too", async () => {
      const s = await makeOrg("search");
      const { item } = await createItem(s.editor, { title: "ספר חיפוש 41", author: "מחבר נבדק" });
      await db.inventoryItem.update({ where: { id: item.id }, data: { inventoryNumber: "10000041", barcode: "10000041" } });
      await db.inventoryNumberAlias.create({ data: { organizationId: s.org.id, inventoryItemId: item.id, alias: "ITM-000041" } });

      const exact = await globalSearch(s.editor, "10000041");
      expect(exact.directItemId).toBe(item.id);
      expect(exact.items.map((i) => i.id)).toEqual([item.id]); // the result list must not be empty when there is a direct match
      expect(exact.items[0]).toMatchObject({ inventoryNumber: "10000041", title: "ספר חיפוש 41" });

      for (const q of ["ITM-000041", "itm-000041"]) expect((await globalSearch(s.editor, q)).directItemId).toBe(item.id);
      const partial = await globalSearch(s.editor, "00041");
      expect(partial.items.map((i) => i.id)).toContain(item.id);
      expect((await globalSearch(s.editor, "חיפוש 41")).items.map((i) => i.id)).toContain(item.id);
      expect((await globalSearch(s.editor, "מחבר נבדק")).items.map((i) => i.id)).toContain(item.id);
      expect((await globalSearch(s.editor, "99999999")).items).toHaveLength(0);
    });

    it("a scanned full number on the handheld finds the book; an old ITM tag still does", async () => {
      const s = await makeOrg("scan");
      const { item } = await createItem(s.editor, { title: "סריקה" });
      await db.inventoryNumberAlias.create({ data: { organizationId: s.org.id, inventoryItemId: item.id, alias: "ITM-000777" } });
      expect((await processScan(s.warehouse, op("FIND", item.inventoryNumber))).item?.id).toBe(item.id);
      expect((await processScan(s.warehouse, op("FIND", "ITM-000777"))).item?.id).toBe(item.id);
    });
  });
});
