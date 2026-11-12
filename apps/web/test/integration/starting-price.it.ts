import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog, setLotCommercialStatus } from "@/server/services/assignments";
import { deleteLot, listLots, moveLotToCatalog } from "@/server/services/lots";
import { dissolveLot, mergeLots } from "@/server/services/lot-members";
import { catalogPriceSummary, lotPriceHistory, previousPricesOfBook, setStartingPrice } from "@/server/services/lot-pricing";
import { buildCatalogWorkbook } from "@/server/services/catalog-xlsx";
import { can } from "@/server/auth/permissions";
import { parseUsd, addMoney, formatUsd } from "@/lib/money";
import { hasDb, makeOrg, createBook } from "./helpers";

describe("money helpers", () => {
  it("parses dollars exactly; empty is null, zero and garbage are refused", () => {
    expect(parseUsd("$1,250")).toBe("1250.00");
    expect(parseUsd(150)).toBe("150.00");
    expect(parseUsd("150.5")).toBe("150.50");
    expect(parseUsd("")).toBeNull();
    expect(parseUsd(null)).toBeNull();
    expect(parseUsd("   ")).toBeNull();
    expect(() => parseUsd("0")).toThrow(/גדול מאפס/);
    expect(() => parseUsd("12.345")).toThrow();
    expect(() => parseUsd("abc")).toThrow();
    expect(() => parseUsd("-5")).toThrow();
  });
  it("sums without floating point errors", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(addMoney("19.99", "0.01", null)).toBe("20.00");
    expect(formatUsd("1250.00")).toBe("$1,250");
    expect(formatUsd("1250.50")).toBe("$1,250.50");
    expect(formatUsd(null)).toBe("לא הוגדר");
  });
});

describe.skipIf(!hasDb)("starting price on the lot (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("price");
  });

  async function setup(n: number) {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `P${++seq}-${Date.now() % 100000}`, name: "קטלוג מחירים" });
    const lots = [];
    for (let i = 0; i < n; i++) {
      const { item } = await createBook(ctx.editor, { title: `ספר ${i + 1}` });
      lots.push({ lot: await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id }), item });
    }
    return { catalog, lots };
  }
  const priceOf = async (lotId: string) => (await db.lot.findUniqueOrThrow({ where: { id: lotId } })).startingPrice?.toFixed(2) ?? null;

  it("a book only in stock has no price; assigning it creates a lot with an empty price (not 0)", async () => {
    const { lots } = await setup(1);
    expect(await priceOf(lots[0]!.lot.id)).toBeNull();
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })) as Record<string, unknown>).not.toHaveProperty("startingPrice");
  });

  it("set, change and clear: exact value, version grows, every change is in the history with who and the previous value", async () => {
    const { lots } = await setup(1);
    const id = lots[0]!.lot.id;
    const a = await setStartingPrice(ctx.editor, id, { price: "$150" });
    expect(a).toMatchObject({ startingPrice: "150.00", priceVersion: 1, changed: true });
    const same = await setStartingPrice(ctx.editor, id, { price: 150 });
    expect(same.changed).toBe(false);
    expect(same.priceVersion).toBe(1);
    await setStartingPrice(ctx.admin, id, { price: "300.50" });
    await setStartingPrice(ctx.editor, id, { price: "" });
    expect(await priceOf(id)).toBeNull();
    const h = await lotPriceHistory(ctx.editor, id);
    expect(h.map((e) => [e.kind, e.previous, e.next]).reverse()).toEqual([
      ["SET", null, "150.00"],
      ["CHANGE", "150.00", "300.50"],
      ["CLEAR", "300.50", null],
    ]);
    expect(h[1]!.by).toBe("ADMIN");
  });

  it("empty is not zero: zero, negative and sub-cent values are refused and nothing changes", async () => {
    const { lots } = await setup(1);
    const id = lots[0]!.lot.id;
    await setStartingPrice(ctx.editor, id, { price: "200" });
    for (const bad of ["0", "-1", "1.234", "abc"]) {
      await expect(setStartingPrice(ctx.editor, id, { price: bad })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(await priceOf(id)).toBe("200.00");
  });

  it("two people editing at once: the second save is refused with the current value (no silent overwrite)", async () => {
    const { lots } = await setup(1);
    const id = lots[0]!.lot.id;
    const v0 = (await setStartingPrice(ctx.editor, id, { price: "100" })).priceVersion;
    await setStartingPrice(ctx.admin, id, { price: "120", expectedVersion: v0 });
    const err = await setStartingPrice(ctx.editor, id, { price: "130", expectedVersion: v0 }).catch((e) => e);
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ code: "PRICE_CONFLICT", current: "120.00", changedBy: "ADMIN" });
    expect(await priceOf(id)).toBe("120.00");
  });

  it("permissions: only managers edit the price; warehouse staff and viewers cannot", () => {
    expect(can("EDITOR", "lot.price.edit")).toBe(true);
    expect(can("ADMIN", "lot.price.edit")).toBe(true);
    expect(can("WAREHOUSE", "lot.price.edit")).toBe(false);
    expect(can("VIEWER", "lot.price.edit")).toBe(false);
    expect(can("PHOTOGRAPHER", "lot.price.edit")).toBe(false);
  });

  it("the catalog table carries the price as an exact string; the counters say how many lots have none", async () => {
    const { catalog, lots } = await setup(4);
    await setStartingPrice(ctx.editor, lots[0]!.lot.id, { price: "150" });
    await setStartingPrice(ctx.editor, lots[1]!.lot.id, { price: "300" });
    const rows = await listLots(ctx.editor, catalog.id);
    expect(rows.map((r) => r.startingPrice)).toEqual(["150.00", "300.00", null, null]);
    expect(await catalogPriceSummary(catalog.id)).toEqual({ total: 4, withPrice: 2, withoutPrice: 2 });
  });

  describe("combined lots", () => {
    it("merging lots that have prices demands a decision; the prices are never added up", async () => {
      const { catalog, lots } = await setup(3);
      await setStartingPrice(ctx.editor, lots[0]!.lot.id, { price: "100" });
      await setStartingPrice(ctx.editor, lots[1]!.lot.id, { price: "200" });
      const ids = lots.slice(0, 2).map((l) => l.lot.id);
      const err = await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: ids, keepLotId: ids[0]! }).catch((e) => e);
      expect(err.details).toMatchObject({ code: "PRICE_DECISION_REQUIRED" });
      expect(err.details.prices.map((p: { price: string | null }) => p.price)).toEqual(["100.00", "200.00"]);
      // nothing was merged
      expect((await db.lot.findUniqueOrThrow({ where: { id: ids[1]! } })).mergedIntoLotId).toBeNull();

      await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: ids, keepLotId: ids[0]!, startingPrice: "250" });
      expect(await priceOf(ids[0]!)).toBe("250.00");
      // the absorbed lot keeps its own price as history, with an event
      expect(await priceOf(ids[1]!)).toBe("200.00");
      const kinds = (await db.lotPriceEvent.findMany({ where: { lotId: { in: ids } } })).map((e) => e.kind).sort();
      expect(kinds).toEqual(["MERGED_FROM", "MERGED_INTO", "SET"].concat("SET").sort());
    });

    it("keeping the kept lot's price must be explicit; with no prices at all no decision is needed", async () => {
      const a = await setup(2);
      await setStartingPrice(ctx.editor, a.lots[0]!.lot.id, { price: "100" });
      const ids = a.lots.map((l) => l.lot.id);
      await mergeLots(ctx.editor, { catalogId: a.catalog.id, lotIds: ids, keepLotId: ids[0]!, keepPrice: true });
      expect(await priceOf(ids[0]!)).toBe("100.00");

      const b = await setup(2);
      const bids = b.lots.map((l) => l.lot.id);
      await mergeLots(ctx.editor, { catalogId: b.catalog.id, lotIds: bids, keepLotId: bids[0]! });
      expect(await priceOf(bids[0]!)).toBeNull();
    });

    it("dissolving a combined lot does not split the price: the lots start empty and the old prices stay in the history", async () => {
      const { catalog, lots } = await setup(2);
      const ids = lots.map((l) => l.lot.id);
      await setStartingPrice(ctx.editor, ids[1]!, { price: "70" });
      await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: ids, keepLotId: ids[0]!, startingPrice: "500" });
      await dissolveLot(ctx.editor, ids[0]!);
      expect(await priceOf(ids[0]!)).toBeNull();
      const active = await db.lot.findMany({ where: { catalogId: catalog.id, assignmentStatus: "ACTIVE" } });
      expect(active).toHaveLength(2);
      expect(active.every((l) => l.startingPrice === null)).toBe(true);
      const history = await db.lotPriceEvent.findMany({ where: { catalogId: catalog.id, kind: "DISSOLVED" } });
      expect(history.map((e) => e.previous?.toFixed(2)).sort()).toEqual(["500.00", "70.00"].sort());
    });
  });

  describe("leaving a catalog", () => {
    it("moving to another catalog: the new lot starts empty, the old price stays on the ended lot and in the history; earlier prices are shown for information", async () => {
      const { lots } = await setup(1);
      const target = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `T${++seq}-${Date.now() % 100000}`, name: "יעד" });
      const lot = lots[0]!.lot;
      await setStartingPrice(ctx.editor, lot.id, { price: "400" });
      const moved = await moveLotToCatalog(ctx.editor, lot.id, target.id);
      expect(await priceOf(moved.id)).toBeNull();
      expect(await priceOf(lot.id)).toBe("400.00");
      expect((await lotPriceHistory(ctx.editor, lot.id)).map((e) => e.kind)).toContain("ENDED");
      const before = await previousPricesOfBook(ctx.editor, lots[0]!.item.id);
      expect(before).toEqual([expect.objectContaining({ price: "400.00", active: false })]);
      // the ended assignment's price can no longer be edited
      await expect(setStartingPrice(ctx.editor, lot.id, { price: "1" })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("deleting a mistaken assignment keeps the price in the history", async () => {
      const { catalog, lots } = await setup(1);
      const lot = lots[0]!.lot;
      await setStartingPrice(ctx.editor, lot.id, { price: "55" });
      await deleteLot(ctx.editor, lot.id);
      const ev = await db.lotPriceEvent.findMany({ where: { catalogId: catalog.id } });
      expect(ev.map((e) => e.kind).sort()).toEqual(["DELETED", "SET"]);
      expect(ev.every((e) => e.lotId === null && e.lotNumber === lot.lotNumber)).toBe(true);
    });

    it("a sold lot keeps its starting price", async () => {
      const { lots } = await setup(1);
      const lot = lots[0]!.lot;
      await setStartingPrice(ctx.editor, lot.id, { price: "90" });
      await setLotCommercialStatus(ctx.editor, lot.id, { status: "SOLD" });
      expect(await priceOf(lot.id)).toBe("90.00");
    });
  });

  describe("Excel export", () => {
    async function rowsOf(buffer: Buffer) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as never);
      const ws = wb.getWorksheet("Lots")!;
      const out: (string | number | null)[][] = [];
      ws.eachRow((r) => out.push((r.values as (string | number | null)[]).slice(1)));
      return { header: out[0]!, data: out.slice(1), notes: wb.getWorksheet("AVOT")! };
    }

    it("exports every active lot (one row per lot, a combined lot once), prices as numbers, missing price empty, and says it was not verified against Bidspirit", async () => {
      const { catalog, lots } = await setup(5);
      await setStartingPrice(ctx.editor, lots[0]!.lot.id, { price: "150" });
      await setStartingPrice(ctx.editor, lots[1]!.lot.id, { price: "300.5" });
      const ids = lots.map((l) => l.lot.id);
      await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: [ids[3]!, ids[4]!], keepLotId: ids[3]! });
      // a lot that left the catalog is history and is not exported
      await setLotCommercialStatus(ctx.editor, ids[2]!, { status: "WITHDRAWN" });

      const f = await buildCatalogWorkbook(ctx.editor, catalog.id);
      expect(f).toMatchObject({ lots: 3, missingPrices: 1 });
      expect(f.profile.verified).toBe(false);
      const { header, data, notes } = await rowsOf(f.buffer);
      expect(header).toEqual(["itemIndex", "startPrice", "mainLangName", "mainLangDesc", "mainLangAuthor"]);
      expect(data.map((r) => r[0])).toEqual([1, 2, 4]); // lot 3 left the catalog: not exported
      expect(data.map((r) => r[1] ?? null)).toEqual([150, 300.5, null]);
      const text = JSON.stringify(notes.getSheetValues());
      expect(text).toContain("לא");
      expect(text).toContain("תבנית הייבוא הרשמית");
    });

    it("the export does not depend on any screen filter: it always returns the whole catalog", async () => {
      const { catalog, lots } = await setup(3);
      await setStartingPrice(ctx.editor, lots[0]!.lot.id, { price: "10" });
      const a = await buildCatalogWorkbook(ctx.editor, catalog.id);
      const b = await buildCatalogWorkbook(ctx.editor, catalog.id, "public-legacy");
      expect(a.lots).toBe(3);
      expect(b.lots).toBe(3);
    });

    it("another organization cannot export the catalog", async () => {
      const { catalog } = await setup(1);
      const other = await makeOrg("price-other");
      await expect(buildCatalogWorkbook(other.admin, catalog.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
