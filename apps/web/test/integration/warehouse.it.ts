import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyCode } from "@avot/shared";
import { db } from "@/server/db";
import { createItem } from "@/server/services/inventory";
import { processScan } from "@/server/services/scanning";
import { createPrintJobs, createPrinter, claimNextPrintJob, reportPrintJob } from "@/server/services/printing";
import {
  addColumn,
  addShelvesToColumn,
  createWarehouseFromWizard,
  manualMove,
  renameColumn,
  renameWarehouse,
  reorderStructure,
  setShelfActive,
  shelfContents,
  warehouseTree,
} from "@/server/services/warehouse";
import { hasDb, makeOrg, pairAgent } from "./helpers";

const op = (mode: "STORE" | "TRANSFER" | "FIND" | "COUNT" | "PICK", code: string, extra: Record<string, unknown> = {}) => ({
  opId: randomUUID(),
  mode,
  code,
  clientAt: new Date().toISOString(),
  ...extra,
});

describe.skipIf(!hasDb)("warehouse wizard, structure, phone scanner flows (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let wh: { id: string; code: string };
  beforeAll(async () => {
    ctx = await makeOrg("wh");
  });

  it("wizard: 'מחסן 1 · 8 עמודות · 5 מדפים' creates 8 columns, 40 shelves and 40 locations with unique scannable codes", async () => {
    wh = await createWarehouseFromWizard(ctx.admin, { name: "מחסן 1", columns: 8, shelvesPerColumn: 5 });
    const tree = (await warehouseTree(ctx.org.id)).find((w) => w.id === wh.id)!;
    expect(tree.isDefault).toBe(true);
    expect(tree.zones).toHaveLength(8);
    expect(tree.zones.map((z) => z.name)).toEqual(Array.from({ length: 8 }, (_, i) => `עמודה ${i + 1}`));
    const shelves = tree.zones.flatMap((z) => z.shelves);
    expect(shelves).toHaveLength(40);
    expect(shelves.every((s) => s.locations.length === 1)).toBe(true);
    const codes = shelves.flatMap((s) => s.locations.map((l) => l.code));
    expect(new Set(codes).size).toBe(40);
    expect(codes[0]).toBe("LOC-C1-01");
    expect(codes.at(-1)).toBe("LOC-C8-05");
    for (const c of codes) expect(classifyCode(c)).toEqual({ type: "LOCATION", value: c });
  });

  it("a second warehouse gets its own code prefix; duplicate names are refused", async () => {
    const w2 = await createWarehouseFromWizard(ctx.admin, { name: "מחסן 2", columns: 2, shelvesPerColumn: 3 });
    expect(w2.code).toBe("W2");
    const t = (await warehouseTree(ctx.org.id)).find((w) => w.id === w2.id)!;
    expect(t.zones[0]!.shelves[0]!.locations[0]!.code).toBe("LOC-W2-C1-01");
    await expect(createWarehouseFromWizard(ctx.admin, { name: "מחסן 2", columns: 1, shelvesPerColumn: 1 })).rejects.toThrow(/כבר קיים/);
  });

  it("adding a column / shelves continues the numbering and never touches existing codes", async () => {
    const before = (await db.storageLocation.findMany({ where: { organizationId: ctx.org.id }, select: { id: true, code: true } })).sort((a, b) => a.id.localeCompare(b.id));
    const col = await addColumn(ctx.admin, { warehouseId: wh.id, shelves: 2 });
    expect(col.code).toBe("C9");
    const zone1 = (await db.warehouseZone.findFirstOrThrow({ where: { warehouseId: wh.id, code: "C1" } })).id;
    await addShelvesToColumn(ctx.admin, { zoneId: zone1, count: 2 });
    expect((await db.shelf.findMany({ where: { zoneId: zone1 }, orderBy: { sortOrder: "asc" } })).map((s) => s.code)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
    const after = await db.storageLocation.findMany({ where: { id: { in: before.map((b) => b.id) } }, select: { id: true, code: true } });
    expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual(before);
    expect(await db.storageLocation.count({ where: { organizationId: ctx.org.id, shelf: { zone: { warehouseId: wh.id } } } })).toBe(40 + 2 + 2);
  });

  it("renaming and reordering are display-only: location codes (printed barcodes) never change", async () => {
    const zones = await db.warehouseZone.findMany({ where: { warehouseId: wh.id }, orderBy: { sortOrder: "asc" } });
    const codesBefore = (await db.storageLocation.findMany({ where: { organizationId: ctx.org.id }, select: { code: true } })).map((l) => l.code).sort();
    await renameWarehouse(ctx.admin, wh.id, "המחסן הראשי");
    await renameColumn(ctx.admin, zones[0]!.id, "ספרי קודש");
    await reorderStructure(ctx.admin, { kind: "columns", parentId: wh.id, orderedIds: [...zones].reverse().map((z) => z.id) });
    const zonesAfter = await db.warehouseZone.findMany({ where: { warehouseId: wh.id }, orderBy: { sortOrder: "asc" } });
    expect(zonesAfter[0]!.code).toBe("C9");
    expect(zonesAfter.at(-1)!.name).toBe("ספרי קודש");
    expect((await db.storageLocation.findMany({ where: { organizationId: ctx.org.id }, select: { code: true } })).map((l) => l.code).sort()).toEqual(codesBefore);
    await expect(reorderStructure(ctx.admin, { kind: "columns", parentId: wh.id, orderedIds: [zones[0]!.id] })).rejects.toThrow(/אינה תואמת/);
  });

  it("a shelf with books cannot be disabled; an empty one can, and scanners then refuse it", async () => {
    const shelf = await db.shelf.findFirstOrThrow({ where: { zone: { warehouseId: wh.id, code: "C2" }, code: "01" }, include: { locations: true } });
    const loc = shelf.locations[0]!;
    const { item } = await createItem(ctx.editor, { title: "על המדף" });
    await manualMove(ctx.admin, item.id, { locationId: loc.id });
    await expect(setShelfActive(ctx.admin, shelf.id, false)).rejects.toThrow(/ספרים/);
    const contents = await shelfContents(ctx.org.id, shelf.id);
    expect(contents.items.map((i) => i.id)).toEqual([item.id]);
    const empty = await db.shelf.findFirstOrThrow({ where: { zone: { warehouseId: wh.id, code: "C2" }, code: "02" }, include: { locations: true } });
    await setShelfActive(ctx.admin, empty.id, false);
    const r = await processScan(ctx.warehouse, op("STORE", empty.locations[0]!.code));
    expect(r.result).toBe("ERROR");
    expect(r.message).toMatch(/מושבת/);
  });

  describe("phone scanner flows", () => {
    let shelfA: { id: string; code: string };
    let shelfB: { id: string; code: string };
    beforeAll(async () => {
      const get = async (zone: string, code: string) => (await db.storageLocation.findFirstOrThrow({ where: { organizationId: ctx.org.id, shelf: { zone: { warehouseId: wh.id, code: zone }, code } } }));
      shelfA = await get("C3", "01");
      shelfB = await get("C3", "02");
    });

    it("put-away: scan shelf, then books in a row — each book gets that exact shelf and a movement record", async () => {
      const books = [];
      for (let i = 0; i < 3; i++) books.push((await createItem(ctx.editor, { title: `קליטה ${i}` })).item);
      const s = await processScan(ctx.warehouse, op("STORE", shelfA.code));
      expect(s).toMatchObject({ result: "OK", codeType: "LOCATION" });
      for (const b of books) {
        const r = await processScan(ctx.warehouse, op("STORE", b.barcode, { contextLocationId: s.activeLocation!.id }));
        expect(r.result).toBe("OK");
      }
      expect(await db.inventoryItem.count({ where: { currentLocationId: shelfA.id } })).toBe(3);
      expect(await db.inventoryLocationMovement.count({ where: { toLocationId: shelfA.id, kind: "STORE", userId: ctx.warehouse.userId } })).toBe(3);
      // switching shelf without leaving the flow
      const s2 = await processScan(ctx.warehouse, op("STORE", shelfB.code));
      const r2 = await processScan(ctx.warehouse, op("STORE", books[0]!.barcode, { contextLocationId: s2.activeLocation!.id }));
      expect(r2.result).toBe("OK");
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: books[0]!.id } })).currentLocationId).toBe(shelfB.id);
      const mv = await db.inventoryLocationMovement.findFirstOrThrow({ where: { inventoryItemId: books[0]!.id }, orderBy: { createdAt: "desc" } });
      expect(mv).toMatchObject({ fromLocationId: shelfA.id, toLocationId: shelfB.id, kind: "TRANSFER" });
    });

    it("a column label is refused where a shelf is needed; a book without a shelf is refused", async () => {
      const col = await processScan(ctx.warehouse, op("STORE", "COL-C3"));
      expect(col.result).toBe("ERROR");
      expect(col.codeType).toBe("ZONE");
      expect(col.message).toMatch(/עמודה/);
      const { item } = await createItem(ctx.editor, { title: "בלי מדף" });
      const r = await processScan(ctx.warehouse, op("STORE", item.barcode));
      expect(r.result).toBe("ERROR");
      expect(r.message).toMatch(/מדף/);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentLocationId).toBeNull();
    });

    it("the same scan sent twice (lost response, offline retry) is applied once and answered the same", async () => {
      const { item } = await createItem(ctx.editor, { title: "פעמיים" });
      const s = await processScan(ctx.warehouse, op("STORE", shelfA.code));
      const same = op("STORE", item.barcode, { contextLocationId: s.activeLocation!.id });
      const [r1, r2] = [await processScan(ctx.warehouse, same), await processScan(ctx.warehouse, same)];
      expect(r1.result).toBe("OK");
      expect(r2.opId).toBe(r1.opId);
      expect(await db.inventoryLocationMovement.count({ where: { inventoryItemId: item.id } })).toBe(1);
    });

    it("find: shows the exact place; late (offline) sync never overwrites a newer move — it becomes a conflict", async () => {
      const { item } = await createItem(ctx.editor, { title: "מתעדכן מאוחר" });
      const s = await processScan(ctx.warehouse, op("STORE", shelfA.code));
      const scannedAt = new Date(Date.now() - 60_000).toISOString();
      // someone else moves the book to B after the (offline) scan happened
      await manualMove(ctx.admin, item.id, { locationId: shelfB.id });
      const late = await processScan(ctx.warehouse, op("STORE", item.barcode, { contextLocationId: s.activeLocation!.id, clientAt: scannedAt, deferred: true }));
      expect(late.result).toBe("CONFLICT");
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentLocationId).toBe(shelfB.id);
      const found = await processScan(ctx.warehouse, op("FIND", item.barcode));
      expect(found.item?.location?.code).toBe(shelfB.code);
    });

    it("stock count lists discrepancies but never moves books by itself", async () => {
      const { startCount } = await import("@/server/services/counting");
      const { item } = await createItem(ctx.editor, { title: "בספירה" });
      await manualMove(ctx.admin, item.id, { locationId: shelfA.id });
      const session = await startCount(ctx.admin, { warehouseId: wh.id });
      const s = await processScan(ctx.warehouse, op("COUNT", shelfB.code, { countSessionId: session.id }));
      const r = await processScan(ctx.warehouse, op("COUNT", item.barcode, { contextLocationId: s.activeLocation!.id, countSessionId: session.id }));
      expect(r.warning).toBe(true);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentLocationId).toBe(shelfA.id);
    });

    it("taking a book out: temporary removal leaves it 'awaiting storage' and shelving it again works; final removal ships a sold book only", async () => {
      const { item } = await createItem(ctx.editor, { title: "יוצא ונכנס" });
      await manualMove(ctx.admin, item.id, { locationId: shelfA.id });

      const out = await processScan(ctx.warehouse, op("PICK", item.barcode, { intent: "TEMP_OUT" }));
      expect(out.result).toBe("OK");
      let row = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row.currentLocationId).toBeNull();
      expect(row.physicalStatus).toBe("AWAITING_STORAGE");
      const again = await processScan(ctx.warehouse, op("PICK", item.barcode, { intent: "TEMP_OUT" }));
      expect(again.result).toBe("NOOP");
      const s = await processScan(ctx.warehouse, op("STORE", shelfB.code));
      const back = await processScan(ctx.warehouse, op("STORE", item.barcode, { contextLocationId: s.activeLocation!.id }));
      expect(back.result).toBe("OK");
      row = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row).toMatchObject({ currentLocationId: shelfB.id, physicalStatus: "IN_STORAGE" });

      // final removal: refused without a shipping task, works with one, and is final
      const noTask = await processScan(ctx.warehouse, op("PICK", item.barcode, { intent: "FINAL_OUT" }));
      expect(noTask.result).toBe("ERROR");
      expect(noTask.message).toMatch(/משלוח/);
      await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: item.id, reason: "נמכר", status: "OPEN", sourceLocationId: shelfB.id } });
      const fin = await processScan(ctx.warehouse, op("PICK", item.barcode, { intent: "FINAL_OUT" }));
      expect(fin.result).toBe("OK");
      row = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row).toMatchObject({ currentLocationId: null, physicalStatus: "SHIPPED" });
      const task = await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: item.id } });
      expect(task.status).toBe("SHIPPED");
      expect(task.pickedAt && task.packedAt && task.shippedAt).toBeTruthy();
      const twice = await processScan(ctx.warehouse, op("PICK", item.barcode, { intent: "FINAL_OUT" }));
      expect(twice.result).toBe("NOOP");
      // a shipped book can never be put back on a shelf by a scan
      const s2 = await processScan(ctx.warehouse, op("STORE", shelfA.code));
      const re = await processScan(ctx.warehouse, op("STORE", item.barcode, { contextLocationId: s2.activeLocation!.id }));
      expect(re.result).toBe("ERROR");
    });

    it("permissions: only warehouse operators scan to store; viewers and photographers cannot", async () => {
      const { item } = await createItem(ctx.editor, { title: "הרשאות" });
      await expect(processScan(ctx.viewer, op("STORE", shelfA.code))).rejects.toThrow();
      await expect(processScan(ctx.photographer, op("STORE", item.barcode))).rejects.toThrow();
    });
  });

  describe("labels for the structure", () => {
    it("print a single shelf, a whole column and the whole warehouse — through the print queue", async () => {
      const agent = await pairAgent(ctx.admin, "PRINT", "label-pc");
      await createPrinter(ctx.admin, { name: "Zebra", connection: "NETWORK", host: "10.0.0.9", port: 9100, labelSize: "57x32", dotsPerMm: 8 });
      const zone = await db.warehouseZone.findFirstOrThrow({ where: { warehouseId: wh.id, code: "C4" } });
      const shelf = await db.shelf.findFirstOrThrow({ where: { zoneId: zone.id, code: "01" }, include: { locations: true } });

      const [single] = await createPrintJobs(ctx.warehouse, { items: [{ type: "LOCATION", id: shelf.locations[0]!.id }] });
      expect(single!.labelCount).toBe(1);
      const [column] = await createPrintJobs(ctx.warehouse, { zoneId: zone.id });
      expect(column!.labelCount).toBe(6); // column label + 5 shelves
      const all = await createPrintJobs(ctx.warehouse, { warehouseId: wh.id });
      expect(all.reduce((a, j) => a + j.labelCount, 0)).toBe(9 /* columns */ + 43 /* shelves: the disabled one is skipped */);

      const claimed = await claimNextPrintJob(agent);
      expect(claimed!.zpl).toContain("^FDLOC-C4-01");
      await reportPrintJob(agent, claimed!.jobId, { status: "DONE" });
    });
  });
});
