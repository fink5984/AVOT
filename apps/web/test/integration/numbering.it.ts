import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyCode } from "@avot/shared";
import { db } from "@/server/db";
import { createItem, findItemByCode, listInventory } from "@/server/services/inventory";
import { assignToCatalog } from "@/server/services/assignments";
import { createCatalog } from "@/server/services/catalogs";
import { processScan } from "@/server/services/scanning";
import { createWarehouseFromWizard, manualMove } from "@/server/services/warehouse";
import { requestDeleteItems, runDeleteItemsJob } from "@/server/services/deletion";
import { createPrintJobs, createPrinter, claimNextPrintJob } from "@/server/services/printing";
import { globalSearch } from "@/server/services/search";
import { hasDb, makeOrg, pairAgent } from "./helpers";

/** the data part of the migration (everything after the DDL): alias, barcode, number */
const MIGRATION = readFileSync(path.join(__dirname, "../../prisma/migrations/20261028090000_numeric_inventory_numbers/migration.sql"), "utf8");
const dataSteps = () => {
  const guard = MIGRATION.slice(MIGRATION.indexOf("DO $$"), MIGRATION.indexOf("END $$;") + "END $$;".length);
  const rest = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO "InventoryNumberAlias"'), MIGRATION.lastIndexOf("COMMIT;"));
  return { guard, statements: rest.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean) };
};

const op = (mode: "STORE" | "FIND", code: string, extra: Record<string, unknown> = {}) => ({ opId: randomUUID(), mode, code, clientAt: new Date().toISOString(), ...extra });

describe.skipIf(!hasDb)("numeric inventory numbers (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => {
    ctx = await makeOrg("num");
  });

  it("new books get digits-only numbers from an atomic sequence: 25 parallel creations, no duplicates, no gaps", async () => {
    const made = await Promise.all(Array.from({ length: 25 }, (_, i) => createItem(ctx.editor, { title: `מקבילי ${i}`, opId: randomUUID() })));
    const nums = made.map((m) => m.item.inventoryNumber);
    expect(new Set(nums).size).toBe(25);
    for (const m of made) {
      expect(m.item.inventoryNumber).toMatch(/^\d{8,}$/);
      expect(m.item.inventoryNumber).not.toContain("ITM");
      expect(m.item.barcode).toBe(m.item.inventoryNumber);
      expect(BigInt(m.item.inventoryNumber)).toBe(10_000_000n + BigInt(m.item.serial));
    }
    const serials = made.map((m) => Number(m.item.serial)).sort((a, b) => a - b);
    expect(serials.at(-1)! - serials[0]!).toBe(24); // consecutive: one atomic counter, nothing skipped
  });

  it("a deleted book's number is never handed out again", async () => {
    const { item: gone } = await createItem(ctx.editor, { title: "יימחק" });
    const { jobId } = await requestDeleteItems(ctx.admin, [gone.id]);
    await runDeleteItemsJob(await db.job.findUniqueOrThrow({ where: { id: jobId } }));
    expect(await db.inventoryItem.count({ where: { id: gone.id } })).toBe(0);
    const { item: next } = await createItem(ctx.editor, { title: "אחריו" });
    expect(BigInt(next.inventoryNumber)).toBeGreaterThan(BigInt(gone.inventoryNumber));
    expect(next.inventoryNumber).not.toBe(gone.inventoryNumber);
  });

  it("one number per book for life: moving between אבות and טבין and between catalogs never changes it", async () => {
    const { item } = await createItem(ctx.editor, { title: "נודד" });
    const a = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "N1", name: "אבות" });
    const t = await createCatalog(ctx.editor, { auctionHouseId: ctx.house2.id, number: "N1", name: "טבין" });
    const l1 = await assignToCatalog(ctx.editor, item.id, { catalogId: a.id });
    const l2 = await assignToCatalog(ctx.editor, item.id, { catalogId: t.id, replaceActive: true, endOutcome: "WITHDRAWN" });
    expect([l1.lotNumber, l2.lotNumber]).toEqual([1, 1]); // lot numbers belong to the catalog, not to the book
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).inventoryNumber).toBe(item.inventoryNumber);
  });

  describe("migrating books that already exist (ITM-… → digits) — the real migration statements", () => {
    it("converts legacy rows, keeps UUIDs, photos and lots, follows the barcode, leaves external barcodes alone, saves aliases", async () => {
      const mk = (serial: number, inventoryNumber: string, barcode: string) =>
        db.inventoryItem.create({ data: { organizationId: ctx.org.id, serial: BigInt(serial), inventoryNumber, barcode, title: `ישן ${serial}`, requirements: {} } });
      const plain = await mk(900_001, "ITM-900001", "ITM-900001");
      const tagged = await mk(900_002, "ITM-900002", "9781234567897"); // external EAN registered on the book
      await db.photoAsset.create({
        data: { organizationId: ctx.org.id, inventoryItemId: plain.id, category: "COVER", captureId: randomUUID(), source: "SIMULATOR", sequence: 1, sortOrder: 0, capturedAt: new Date() },
      });
      const { statements } = dataSteps();
      for (const s of statements) await db.$executeRawUnsafe(s);

      const p = await db.inventoryItem.findUniqueOrThrow({ where: { id: plain.id }, include: { aliases: true } });
      expect(p.inventoryNumber).toBe("10900001");
      expect(p.barcode).toBe("10900001");
      expect(p.aliases.map((a) => a.alias)).toEqual(["ITM-900001"]);
      expect(p.id).toBe(plain.id); // the UUID never changes
      expect(await db.photoAsset.count({ where: { inventoryItemId: plain.id } })).toBe(1);

      const t = await db.inventoryItem.findUniqueOrThrow({ where: { id: tagged.id }, include: { aliases: true } });
      expect(t.inventoryNumber).toBe("10900002");
      expect(t.barcode).toBe("9781234567897"); // external tag untouched
      expect(t.aliases[0]!.alias).toBe("ITM-900002");

      // running it again changes nothing (idempotent)
      for (const s of statements) await db.$executeRawUnsafe(s);
      expect(await db.inventoryNumberAlias.count({ where: { inventoryItemId: plain.id } })).toBe(1);

      // OLD printed tag and NEW number find the same book — in lookup, scanner and search
      for (const code of ["ITM-900001", "itm-900001", "10900001"]) expect((await findItemByCode(ctx.org.id, code))?.id).toBe(plain.id);
      expect((await findItemByCode(ctx.org.id, "9781234567897"))?.id).toBe(tagged.id);
      for (const q of ["ITM-900001", "10900001", "900001"]) expect((await listInventory(ctx.admin, { q })).items.map((i) => i.id)).toContain(plain.id);
      expect((await globalSearch(ctx.admin, "ITM-900002")).directItemId).toBe(tagged.id);
    });

    it("refuses to migrate when a converted number would collide with another book's barcode (nothing is changed)", async () => {
      await db.inventoryItem.create({ data: { organizationId: ctx.org.id, serial: 910_001n, inventoryNumber: "ITM-910001", barcode: "ITM-910001", title: "א", requirements: {} } });
      await db.inventoryItem.create({ data: { organizationId: ctx.org.id, serial: 910_002n, inventoryNumber: "ITM-910002", barcode: "10910001", title: "ב", requirements: {} } }); // B's barcode = A's future number
      await expect(db.$executeRawUnsafe(dataSteps().guard)).rejects.toThrow(/collide/);
      expect((await db.inventoryItem.findFirstOrThrow({ where: { organizationId: ctx.org.id, serial: 910_001n } })).inventoryNumber).toBe("ITM-910001");
      // leave no unconvertible rows behind: later runs execute the migration statements over the whole test database
      await db.inventoryItem.deleteMany({ where: { organizationId: ctx.org.id, serial: { in: [910_001n, 910_002n] } } });
    });
  });

  describe("scanning and printing with old and new numbers", () => {
    it("the phone finds a book by its new number and by its old printed tag; shelving works with either", async () => {
      const wh = await createWarehouseFromWizard(ctx.admin, { name: "מחסן מספור", columns: 1, shelvesPerColumn: 1 });
      const loc = await db.storageLocation.findFirstOrThrow({ where: { organizationId: ctx.org.id, shelf: { zone: { warehouseId: wh.id } } } });
      const { item } = await createItem(ctx.editor, { title: "סריקה" });
      await db.inventoryNumberAlias.create({ data: { organizationId: ctx.org.id, inventoryItemId: item.id, alias: "ITM-000321" } });
      await manualMove(ctx.admin, item.id, { locationId: loc.id });
      for (const code of [item.inventoryNumber, "ITM-000321", "itm-321"]) {
        const r = await processScan(ctx.warehouse, op("FIND", code));
        expect(r.result, code).toBe("OK");
        expect(r.item?.inventoryNumber).toBe(item.inventoryNumber);
        expect(r.item?.location?.code).toBe(loc.code);
      }
      const s = await processScan(ctx.warehouse, op("STORE", loc.code));
      const stored = await processScan(ctx.warehouse, op("STORE", "ITM-000321", { contextLocationId: s.activeLocation!.id }));
      expect(["OK", "NOOP"]).toContain(stored.result);
      expect(classifyCode(item.inventoryNumber).type).toBe("ITEM");
    });

    it("a new label prints only the number: native Code 128 of digits, readable number, no ITM text", async () => {
      const agent = await pairAgent(ctx.admin, "PRINT", "num-pc");
      await createPrinter(ctx.admin, { name: "Z", connection: "NETWORK", host: "10.1.1.1", port: 9100, labelSize: "57x32", dotsPerMm: 8 });
      const { item } = await createItem(ctx.editor, { title: "תווית חדשה" });
      await createPrintJobs(ctx.editor, { items: [{ type: "BOOK", id: item.id }] });
      let zpl = "";
      for (let i = 0; i < 20 && !zpl.includes(item.barcode); i++) {
        const c = await claimNextPrintJob(agent);
        if (!c) break;
        zpl = c.zpl;
      }
      expect(zpl).toContain(`^FD${item.barcode}^FS`);
      expect(zpl).not.toContain("ITM");
      expect(item.barcode).toMatch(/^\d+$/);
    });
  });
});
