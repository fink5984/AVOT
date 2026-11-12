import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog } from "@/server/services/assignments";
import { commitImport, createImport } from "@/server/services/sale-import";
import { archiveCatalog, finishSale, finishSalePreview } from "@/server/services/sale-finish";
import { createCustomer } from "@/server/services/customers";
import { recordPayment, recordSale, releasePurchase } from "@/server/services/sales";
import { createShipment, packShipment, shipShipment } from "@/server/services/shipments";
import { pickItemTx } from "@/server/services/picking";
import { hasDb, makeOrg, createBook } from "./helpers";

async function sheet(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("r");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!hasDb)("finishing a sale (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("finish");
  });

  /** a catalog of `n` lots; results: lots 1..sold sold, the next `unsold` unsold, the rest without a result */
  async function sale(n: number, sold: number, unsold: number) {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `F${++seq}-${Date.now() % 100000}`, name: "סיום" });
    const lots = [];
    for (let i = 0; i < n; i++) {
      const { item } = await createBook(ctx.editor, { title: `ספר ${i + 1}` });
      lots.push({ item, lot: await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id }) });
    }
    const rows: (string | number | null)[][] = [["Lot", "Status", "Hammer", "Name", "Email"]];
    for (let i = 1; i <= sold; i++) rows.push([i, "Sold", 100 * i, `קונה ${i}`, `b${seq}-${i}@example.com`]);
    for (let i = sold + 1; i <= sold + unsold; i++) rows.push([i, "Unsold", null, null, null]);
    const up = await createImport(ctx.editor, catalog.id, { fileName: "r.xlsx", buffer: await sheet(rows) });
    await commitImport(ctx.editor, up.importId);
    return { catalog, lots };
  }

  it("a catalog with every result known: numbers are shown, nothing needs attention", async () => {
    const { catalog } = await sale(5, 3, 2);
    const p = await finishSalePreview(ctx.editor, catalog.id);
    expect(p).toMatchObject({ totalLots: 5, soldLots: 3, unsoldLots: 2, unknownLots: 0, buyers: 3, purchases: 3, hammerTotal: "600.00", needAttention: 0 });
  });

  it("a catalog with missing results: lots without a result are NOT turned into 'unsold' by themselves", async () => {
    const { catalog, lots } = await sale(6, 2, 1);
    const p = await finishSalePreview(ctx.editor, catalog.id);
    expect(p).toMatchObject({ unknownLots: 3, needAttention: 3 });
    const r = await finishSale(ctx.editor, catalog.id, { unsold: "RELEASE_TO_STOCK" });
    expect(r.lotsWithoutResult).toBe(3);
    expect(r.markedUnsold).toBe(0);
    // the 3 lots without a result are untouched (still in the sale)
    for (const l of lots.slice(3)) expect((await db.lot.findUniqueOrThrow({ where: { id: l.lot.id } })).commercialStatus).toBe("ASSIGNED");
    // the catalog cannot be archived while results are missing
    await expect(archiveCatalog(ctx.admin, catalog.id)).rejects.toMatchObject({ details: { code: "LOTS_WITHOUT_RESULT", count: 3 } });
    // marking them unsold needs an explicit decision and a reason
    await expect(finishSale(ctx.editor, catalog.id, { markUnknownUnsold: true })).rejects.toMatchObject({ code: "VALIDATION" });
    const again = await finishSale(ctx.editor, catalog.id, { markUnknownUnsold: true, reason: "לא התקבלו תוצאות", unsold: "HOLD_POST_SALE" });
    expect(again.markedUnsold).toBe(3);
    expect(again.lotsWithoutResult).toBe(0);
    await expect(archiveCatalog(ctx.admin, catalog.id)).resolves.toEqual({ archived: true });
  });

  it("unsold lots: stay for a post-auction deal / are released to stock with everything kept / go back to the consignor", async () => {
    const { catalog, lots } = await sale(6, 2, 4);
    const [hold, release, back, left] = lots.slice(2);
    const r = await finishSale(ctx.editor, catalog.id, {
      unsold: "LEAVE",
      overrides: { [hold!.lot.id]: "HOLD_POST_SALE", [release!.lot.id]: "RELEASE_TO_STOCK", [back!.lot.id]: "RETURN_TO_CONSIGNOR" },
    });
    expect(r.applied).toEqual({ HOLD_POST_SALE: 1, RELEASE_TO_STOCK: 1, RETURN_TO_CONSIGNOR: 1 });
    const row = (id: string) => db.lot.findUniqueOrThrow({ where: { id } });
    // A. still bound to the catalog; "not sold at the auction" is distinguishable from "available after the auction"
    expect(await row(hold!.lot.id)).toMatchObject({ commercialStatus: "UNSOLD", assignmentStatus: "ACTIVE", unsoldDisposition: "HOLD_POST_SALE" });
    expect(await row(left!.lot.id)).toMatchObject({ commercialStatus: "UNSOLD", assignmentStatus: "ACTIVE", unsoldDisposition: "NONE" });
    // B. released to stock: the assignment ends, the result stays, the book is free for a new catalog
    expect(await row(release!.lot.id)).toMatchObject({ commercialStatus: "UNSOLD", assignmentStatus: "ENDED", unsoldDisposition: "RELEASED_TO_STOCK" });
    const next = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `N${++seq}-${Date.now() % 100000}`, name: "הבא" });
    const reassigned = await assignToCatalog(ctx.editor, release!.item.id, { catalogId: next.id });
    expect(reassigned.startingPrice).toBeNull();
    expect(await db.lot.count({ where: { id: release!.lot.id } })).toBe(1); // history kept
    // C. back to the consignor: an exit task naming the consignor, and it is NOT a sale
    const task = await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: back!.item.id } });
    expect(task.reason).toContain("החזרה למפקיד");
    expect(await db.purchase.count({ where: { lotId: back!.lot.id } })).toBe(0);
    expect((await row(back!.lot.id)).unsoldDisposition).toBe("RETURN_TO_CONSIGNOR");
    // a lot held for after the auction can still be sold later
    const c = await createCustomer(ctx.editor, { name: "אחרי המכרז", email: `after${seq}@example.com` });
    const late = await recordSale(ctx.editor, { lotId: hold!.lot.id, customerId: c.id, hammerPrice: "40" });
    expect(late).toMatchObject({ afterAuction: true });
  });

  it("finishing the sale is not the end of payments and shipments: they continue after archiving", async () => {
    const { catalog, lots } = await sale(2, 2, 0);
    await finishSale(ctx.editor, catalog.id, {});
    await archiveCatalog(ctx.admin, catalog.id);
    expect((await db.catalog.findUniqueOrThrow({ where: { id: catalog.id } })).status).toBe("ARCHIVED");
    const p = await db.purchase.findFirstOrThrow({ where: { lotId: lots[0]!.lot.id } });
    await recordPayment(ctx.editor, p.orderId, { amount: "100" });
    await releasePurchase(ctx.editor, p.id);
    const s = await createShipment(ctx.editor, { customerId: p.customerId, purchaseIds: [p.id] });
    await db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, lots[0]!.item.id));
    await packShipment(ctx.editor, s.id);
    await expect(shipShipment(ctx.editor, s.id)).resolves.toMatchObject({ status: "SHIPPED" });
  });

  it("archiving requires the sale to be finished first", async () => {
    const { catalog } = await sale(1, 1, 0);
    await expect(archiveCatalog(ctx.admin, catalog.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
