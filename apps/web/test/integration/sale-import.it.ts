import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog } from "@/server/services/assignments";
import { commitImport, createImport, previewImport } from "@/server/services/sale-import";
import { correctPurchase, orderLedger, recordPayment, recordSale, releasePurchase, cancelPurchase } from "@/server/services/sales";
import { createCustomer, mergeCustomers, normPhone, normEmail } from "@/server/services/customers";
import { detectMapping } from "@/server/sales/import-format";
import { hasDb, makeOrg, createBook } from "./helpers";

type Row = (string | number | null)[];
async function xlsx(rows: Row[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("results");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const csv = (rows: Row[]) => Buffer.from(rows.map((r) => r.map((c) => (c === null ? "" : `"${String(c).replace(/"/g, '""')}"`)).join(",")).join("\n"), "utf8");
const HEAD: Row = ["Lot", "Status", "Hammer Price", "Bidder", "Name", "Email", "Phone"];

describe("normalisation", () => {
  it("phones and e-mails are normalised for matching", () => {
    expect(normPhone("050-123 4567")).toBe("972501234567");
    expect(normPhone("+972 50 123 4567")).toBe("972501234567");
    expect(normPhone("12")).toBeNull();
    expect(normEmail(" Dan@Example.COM ")).toBe("dan@example.com");
    expect(normEmail("not an email")).toBeNull();
  });
  it("columns are detected from English and Hebrew headers", () => {
    expect(detectMapping(["Lot Number", "Hammer Price", "Bidder", "Buyer Name", "E-mail", "Phone"])).toMatchObject({ lotNumber: "Lot Number", hammerPrice: "Hammer Price", bidderNumber: "Bidder", buyerName: "Buyer Name", email: "E-mail", phone: "Phone" });
    expect(detectMapping(["מספר לוט", "מחיר פטיש", "שם קונה", "אימייל", "טלפון", "סטטוס"])).toMatchObject({ lotNumber: "מספר לוט", hammerPrice: "מחיר פטיש", buyerName: "שם קונה", email: "אימייל", phone: "טלפון", outcome: "סטטוס" });
  });
});

describe.skipIf(!hasDb)("sale results import (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("saleimp");
  });

  async function setup(n: number) {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `S${++seq}-${Date.now() % 100000}`, name: "מכירה" });
    const lots = [];
    for (let i = 0; i < n; i++) {
      const { item } = await createBook(ctx.editor, { title: `ספר ${i + 1}` });
      lots.push({ lot: await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id }), item });
    }
    return { catalog, lots };
  }
  const imp = async (catalogId: string, rows: Row[], kind: "xlsx" | "csv" = "xlsx") => {
    const buf = kind === "xlsx" ? await xlsx(rows) : csv(rows);
    return createImport(ctx.editor, catalogId, { fileName: kind === "xlsx" ? "results.xlsx" : "results.csv", buffer: buf });
  };

  it("a file of 200 lots: 180 sold, 20 unsold; buyers are matched/created; preview changes nothing; commit creates the purchases", async () => {
    const { catalog } = await setup(200);
    // an existing customer who will be recognised by e-mail
    const known = await createCustomer(ctx.editor, { name: "יצחק כהן", email: "yitzhak@example.com" });
    const rows: Row[] = [HEAD];
    for (let lot = 1; lot <= 200; lot++) {
      if (lot > 180) rows.push([lot, "Unsold", null, null, null, null, null]);
      else {
        const buyer = (lot % 60) + 1; // 60 buyers
        rows.push([lot, "Sold", 100 + lot, buyer, buyer === 1 ? "יצחק כהן" : `קונה ${buyer}`, buyer === 1 ? "YITZHAK@example.com" : `buyer${buyer}@example.com`, `050-000-${String(1000 + buyer)}`]);
      }
    }
    const up = await imp(catalog.id, rows);
    expect(up.rowsInFile).toBe(200);
    expect(up.mapping.results).toMatchObject({ lotNumber: "Lot", hammerPrice: "Hammer Price", outcome: "Status" });

    const pv = await previewImport(ctx.editor, up.importId);
    expect(pv.summary).toMatchObject({ rowsInFile: 200, sold: 180, unsold: 20, buyers: 60, newCustomers: 59, existingCustomers: 1, created: 180, updated: 20, errors: 0, conflicts: 0 });
    // sum of 101..180 plus lots 181..? : lots 1..180 → 100*180 + sum(1..180)
    expect(pv.summary.hammerTotal).toBe(String(100 * 180 + (180 * 181) / 2) + ".00");
    // the preview wrote nothing
    expect(await db.purchase.count({ where: { catalogId: catalog.id } })).toBe(0);
    expect(await db.customer.count({ where: { organizationId: ctx.org.id } })).toBe(1);

    const done = await commitImport(ctx.editor, up.importId);
    expect(done.summary.created).toBe(180);
    expect(await db.purchase.count({ where: { catalogId: catalog.id, status: "ACTIVE" } })).toBe(180);
    expect(await db.customer.count({ where: { organizationId: ctx.org.id } })).toBe(60);
    // the known customer got the purchases (and not a duplicate)
    const kc = await db.purchase.count({ where: { customerId: known.id } });
    expect(kc).toBe(3);
    // commercial states are set, nothing was released to picking, nothing physical changed
    expect(await db.lot.count({ where: { catalogId: catalog.id, commercialStatus: "SOLD" } })).toBe(180);
    expect(await db.lot.count({ where: { catalogId: catalog.id, commercialStatus: "UNSOLD", assignmentStatus: "ACTIVE" } })).toBe(20);
    expect(await db.pickTask.count({ where: { organizationId: ctx.org.id } })).toBe(0);
    // the original file and the history are kept
    const saved = await db.saleResultImport.findUniqueOrThrow({ where: { id: up.importId } });
    expect(saved).toMatchObject({ status: "COMMITTED", fileName: "results.xlsx" });
    expect(saved.storageKey).toBeTruthy();
    expect(await db.saleResultImportRow.count({ where: { importId: up.importId } })).toBe(200);
  }, 300_000);

  it("importing the same file again creates nothing; a corrected file shows the change; manual corrections are never overwritten", async () => {
    const { catalog } = await setup(4);
    const base: Row[] = [HEAD, [1, "Sold", 100, 7, "דנה", "dana@example.com", null], [2, "Sold", 200, 7, "דנה", "dana@example.com", null], [3, "Sold", 300, 8, "רן", "ran@example.com", null], [4, "Unsold", null, null, null, null, null]];
    const a = await imp(catalog.id, base);
    await commitImport(ctx.editor, a.importId);
    const counts = async () => ({ p: await db.purchase.count({ where: { catalogId: catalog.id } }), c: await db.customer.count({ where: { organizationId: ctx.org.id, email: { in: ["dana@example.com", "ran@example.com"] } } }) });
    const first = await counts();

    const b = await imp(catalog.id, base, "csv");
    const pb = await previewImport(ctx.editor, b.importId);
    expect(pb.summary).toMatchObject({ created: 0, unchanged: 4, newCustomers: 0 });
    await commitImport(ctx.editor, b.importId);
    expect(await counts()).toEqual(first);

    // corrected file: lot 2's price changes
    const fixed = base.map((r) => (r[0] === 2 ? [2, "Sold", 250, 7, "דנה", "dana@example.com", null] : r)) as Row[];
    const c = await imp(catalog.id, fixed);
    const pc = await previewImport(ctx.editor, c.importId);
    expect(pc.summary).toMatchObject({ updated: 1, unchanged: 3, created: 0 });
    expect(pc.rows.find((r) => r.lotNumber === 2)!.action).toBe("UPDATE");
    await commitImport(ctx.editor, c.importId);
    const lot2 = await db.lot.findFirstOrThrow({ where: { catalogId: catalog.id, lotNumber: 2 } });
    expect((await db.purchase.findFirstOrThrow({ where: { lotId: lot2.id, status: "ACTIVE" } })).hammerPrice!.toFixed(2)).toBe("250.00");

    // a person corrects lot 3 by hand, a payment is recorded for lot 1's order; a later corrected file does not touch them
    const lot3 = await db.lot.findFirstOrThrow({ where: { catalogId: catalog.id, lotNumber: 3 } });
    const p3 = await db.purchase.findFirstOrThrow({ where: { lotId: lot3.id, status: "ACTIVE" } });
    await correctPurchase(ctx.editor, p3.id, { hammerPrice: "333" });
    const lot1 = await db.lot.findFirstOrThrow({ where: { catalogId: catalog.id, lotNumber: 1 } });
    const p1 = await db.purchase.findFirstOrThrow({ where: { lotId: lot1.id, status: "ACTIVE" } });
    await recordPayment(ctx.editor, p1.orderId!, { amount: "50" });
    const changed = base.map((r) => (r[0] === 3 ? [3, "Sold", 310, 8, "רן", "ran@example.com", null] : r[0] === 1 ? [1, "Sold", 110, 7, "דנה", "dana@example.com", null] : r)) as Row[];
    const d = await imp(catalog.id, changed);
    const pd = await commitImport(ctx.editor, d.importId);
    expect(pd.rows.find((r) => r.lotNumber === 3)!.action).toBe("CONFLICT");
    expect(pd.rows.find((r) => r.lotNumber === 1)!.action).toBe("CONFLICT");
    expect((await db.purchase.findUniqueOrThrow({ where: { id: p3.id } })).hammerPrice!.toFixed(2)).toBe("333.00");
    expect((await db.purchase.findUniqueOrThrow({ where: { id: p1.id } })).hammerPrice!.toFixed(2)).toBe("100.00");
  }, 120_000);

  it("a file with only the sold lots does not make the missing lots 'unsold'", async () => {
    const { catalog } = await setup(5);
    const up = await imp(catalog.id, [HEAD, [1, "Sold", 100, 1, "א", "a1@example.com", null], [2, "Sold", 100, 2, "ב", "b2@example.com", null]]);
    const r = await commitImport(ctx.editor, up.importId);
    expect(r.summary.lotsNotInFile).toBe(3);
    expect(await db.lot.count({ where: { catalogId: catalog.id, commercialStatus: "ASSIGNED" } })).toBe(3);
  });

  it("customers: same name different people stay separate, same e-mail is one person, a name alone is refused, a bidder alone needs details, a conflicting e-mail/phone is ambiguous", async () => {
    const { catalog } = await setup(8);
    const exist1 = await createCustomer(ctx.editor, { name: "אלמוני", email: "x1@example.com" });
    const exist2 = await createCustomer(ctx.editor, { name: "אחר", phone: "052-111-2222" });
    const rows: Row[] = [
      HEAD,
      [1, "Sold", 10, 1, "דוד לוי", "david1@example.com", null],
      [2, "Sold", 10, 2, "דוד לוי", "david2@example.com", null], // same name, another person
      [3, "Sold", 10, 3, "דוד לוי", "DAVID1@example.com", null], // same e-mail as lot 1 → same person
      [4, "Sold", 10, null, "בלי פרטים", null, null], // a name alone
      [5, "Sold", 10, 55, null, null, null], // a bidder number alone
      [6, "Sold", 10, 6, "זהה", "x1@example.com", "052-111-2222"], // e-mail of one customer, phone of another
      [7, "Sold", 10, 7, "תצוגה", "x1@example.com", null], // recognised existing
    ];
    const up = await imp(catalog.id, rows);
    const r = await commitImport(ctx.editor, up.importId);
    const byLot = (n: number) => r.rows.find((x) => x.lotNumber === n)!;
    expect(byLot(1).customerId).not.toBe(byLot(2).customerId);
    expect(byLot(3).customerId).toBe(byLot(1).customerId);
    expect(byLot(4)).toMatchObject({ action: "ERROR" });
    expect(byLot(5)).toMatchObject({ action: "CREATE", customerMatch: "NEEDS_DETAILS" });
    expect(byLot(6)).toMatchObject({ action: "CONFLICT", customerMatch: "AMBIGUOUS" });
    expect(byLot(7).customerId).toBe(exist1.id);
    expect(exist2.id).not.toBe(exist1.id);
    expect((await db.customer.findFirstOrThrow({ where: { id: byLot(5).customerId! } })).needsDetails).toBe(true);
    // the same person never gets a second customer record for the second lot
    expect(await db.customer.count({ where: { organizationId: ctx.org.id, emailNorm: "david1@example.com" } })).toBe(1);
  });

  it("a bidder number is only meaningful inside its own sale: the same number in another sale is not the same person", async () => {
    const a = await setup(1);
    const b = await setup(1);
    await commitImport(ctx.editor, (await imp(a.catalog.id, [HEAD, [1, "Sold", 10, 9, "מציע", null, null]])).importId);
    const second = await commitImport(ctx.editor, (await imp(b.catalog.id, [HEAD, [1, "Sold", 10, 9, "מציע", null, null]])).importId);
    expect(second.rows[0]).toMatchObject({ action: "CREATE", customerMatch: "NEEDS_DETAILS" });
    const ids = (await db.purchase.findMany({ where: { catalogId: { in: [a.catalog.id, b.catalog.id] } } })).map((p) => p.customerId);
    expect(new Set(ids).size).toBe(2);
  });

  it("bad files are refused: wrong type, no lot column", async () => {
    const { catalog } = await setup(1);
    await expect(createImport(ctx.editor, catalog.id, { fileName: "x.pdf", buffer: Buffer.from("%PDF-1.4") })).rejects.toMatchObject({ code: "VALIDATION" });
    const up = await imp(catalog.id, [["foo", "bar"], [1, 2]]);
    await expect(previewImport(ctx.editor, up.importId)).rejects.toMatchObject({ code: "VALIDATION" });
    // fixing the mapping makes it work
    const pv = await previewImport(ctx.editor, up.importId, { results: { lotNumber: "foo", hammerPrice: "bar" } });
    expect(pv.summary.created).toBe(0); // no buyer details at all
    expect(pv.rows[0]!.action).toBe("ERROR");
  });

  it("two files: results plus a separate buyers file linked by bidder number", async () => {
    const { catalog } = await setup(2);
    const results = await xlsx([["Lot", "Hammer", "Bidder"], [1, 120, 31], [2, 80, 32]]);
    const buyers = await xlsx([["Bidder", "Name", "Email"], [31, "שרה", "sara@example.com"], [32, "משה", "moshe@example.com"]]);
    const up = await createImport(ctx.editor, catalog.id, { fileName: "r.xlsx", buffer: results, buyers: { fileName: "b.xlsx", buffer: buyers } });
    const r = await commitImport(ctx.editor, up.importId);
    expect(r.summary).toMatchObject({ created: 2, newCustomers: 2 });
    expect((await db.customer.findFirst({ where: { organizationId: ctx.org.id, emailNorm: "sara@example.com" } }))!.name).toBe("שרה");
  });

  it("money in the file is exact; premium and tax stay unknown when the file does not state them", async () => {
    const { catalog } = await setup(1);
    const up = await imp(catalog.id, [HEAD, [1, "Sold", "$1,250.50", 1, "כסף", "money@example.com", null]]);
    await commitImport(ctx.editor, up.importId);
    const p = await db.purchase.findFirstOrThrow({ where: { catalogId: catalog.id } });
    expect(p.hammerPrice!.toFixed(2)).toBe("1250.50");
    expect(p.buyerPremium).toBeNull();
    expect(p.tax).toBeNull();
    const l = await orderLedger(db, p.orderId);
    expect(l).toMatchObject({ charge: "1250.50", incomplete: true, status: "UNPAID" });
  });

  it("customer merge keeps every purchase and records the merge", async () => {
    const { catalog } = await setup(2);
    await commitImport(ctx.editor, (await imp(catalog.id, [HEAD, [1, "Sold", 10, 1, "ר", "r1@example.com", null], [2, "Sold", 20, 2, "ר", "r2@example.com", null]])).importId);
    const [a, b] = await db.customer.findMany({ where: { organizationId: ctx.org.id, emailNorm: { in: ["r1@example.com", "r2@example.com"] } }, orderBy: { number: "asc" } });
    await mergeCustomers(ctx.editor, b!.id, a!.id);
    expect(await db.purchase.count({ where: { customerId: a!.id, catalogId: catalog.id } })).toBe(2);
    expect(await db.buyerOrder.count({ where: { customerId: a!.id, catalogId: catalog.id } })).toBe(1);
    expect((await db.customer.findUniqueOrThrow({ where: { id: b!.id } })).status).toBe("MERGED");
    expect(await db.saleEvent.count({ where: { customerId: a!.id, kind: "CUSTOMER_MERGED" } })).toBe(1);
  });

  describe("states: commercial, financial, physical are independent", () => {
    it("sold at $800, unpaid, still on the shelf; release needs payment or the special permission; partial payments; cancel keeps the history", async () => {
      const { catalog, lots } = await setup(2);
      const c = await createCustomer(ctx.editor, { name: "לקוח מצבים", email: "states@example.com" });
      const p = await recordSale(ctx.editor, { lotId: lots[0]!.lot.id, customerId: c.id, hammerPrice: "800" });
      const item = () => db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } });
      expect((await item()).physicalStatus).not.toBe("AWAITING_PICK");
      expect((await item()).commercialStatus).toBe("SOLD");
      expect(await db.pickTask.count({ where: { lotId: lots[0]!.lot.id } })).toBe(0);
      expect(await orderLedger(db, p.orderId)).toMatchObject({ status: "UNPAID", due: "800.00" });

      // release before payment: refused for an editor, allowed for an admin (separate permission)
      await expect(releasePurchase(ctx.editor, p.id)).rejects.toMatchObject({ details: { code: "UNPAID_RELEASE" } });
      await recordPayment(ctx.editor, p.orderId!, { amount: "300", method: "העברה", reference: "A1" });
      expect(await orderLedger(db, p.orderId)).toMatchObject({ status: "PARTIAL", paid: "300.00", due: "500.00" });
      await expect(releasePurchase(ctx.editor, p.id)).rejects.toMatchObject({ details: { code: "UNPAID_RELEASE" } });
      await recordPayment(ctx.editor, p.orderId!, { amount: "500" });
      expect(await orderLedger(db, p.orderId)).toMatchObject({ status: "PAID", due: "0.00" });
      const rel = await releasePurchase(ctx.editor, p.id);
      expect(rel.released).toBe(true);
      expect((await item()).physicalStatus).toBe("AWAITING_PICK");
      expect((await releasePurchase(ctx.editor, p.id)).released).toBe(false); // twice = once
      expect(await db.pickTask.count({ where: { lotId: lots[0]!.lot.id, status: "OPEN" } })).toBe(1);

      // an admin may release an unpaid sale; the exception is recorded
      const p2 = await recordSale(ctx.editor, { lotId: lots[1]!.lot.id, customerId: c.id, hammerPrice: "100" });
      const r2 = await releasePurchase(ctx.admin, p2.id, { note: "לקוח ותיק" });
      expect(r2.released && r2.purchase.releasedUnpaid).toBe(true);

      // a second purchase for the same lot is impossible
      await expect(recordSale(ctx.editor, { lotId: lots[1]!.lot.id, customerId: c.id, hammerPrice: "5" })).rejects.toMatchObject({ code: "CONFLICT" });

      // cancellation: kept with buyer, price, reason, who; the lot is not sold, the pick task is cancelled, the book can be assigned again
      await cancelPurchase(ctx.admin, p.id, { reason: "הלקוח חזר בו" });
      const cp = await db.purchase.findUniqueOrThrow({ where: { id: p.id } });
      expect(cp).toMatchObject({ status: "CANCELLED", cancelReason: "הלקוח חזר בו", cancelledById: ctx.admin.userId });
      expect(cp.hammerPrice!.toFixed(2)).toBe("800.00");
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).commercialStatus).toBe("UNSOLD");
      expect((await item()).physicalStatus).toBe("IN_STORAGE" === (await item()).physicalStatus ? "IN_STORAGE" : "AWAITING_STORAGE");
      expect(await db.pickTask.count({ where: { lotId: lots[0]!.lot.id, status: "OPEN" } })).toBe(0);
      expect(await orderLedger(db, p.orderId)).toMatchObject({ charge: "100.00" });
      const again = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `R${++seq}-${Date.now() % 100000}`, name: "חדש" });
      await expect(assignToCatalog(ctx.editor, lots[0]!.item.id, { catalogId: again.id })).resolves.toBeTruthy();
    });

    it("a late sale of a lot that did not sell at the auction keeps both facts", async () => {
      const { catalog, lots } = await setup(2);
      const c = await createCustomer(ctx.editor, { name: "מאוחר", email: "late@example.com" });
      await commitImport(ctx.editor, (await imp(catalog.id, [HEAD, [1, "Unsold", null, null, null, null, null]])).importId);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).commercialStatus).toBe("UNSOLD");
      const p = await recordSale(ctx.editor, { lotId: lots[0]!.lot.id, customerId: c.id, hammerPrice: "75" });
      expect(p).toMatchObject({ afterAuction: true, source: "POST_SALE" });
      expect(await db.saleEvent.count({ where: { purchaseId: p.id, kind: "SOLD_AFTER_AUCTION" } })).toBe(1);
      expect(await db.saleEvent.count({ where: { catalogId: catalog.id, kind: "UNSOLD_AT_AUCTION" } })).toBe(1);
    });

    it("a combined lot is one purchase, one hammer price, several physical books", async () => {
      const { catalog, lots } = await setup(3);
      const { mergeLots } = await import("@/server/services/lot-members");
      const ids = lots.slice(0, 2).map((l) => l.lot.id);
      await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: ids, keepLotId: ids[0]! });
      const c = await createCustomer(ctx.editor, { name: "משולב", email: "combo@example.com" });
      const p = await recordSale(ctx.editor, { lotId: ids[0]!, customerId: c.id, hammerPrice: "900" });
      expect(await db.purchase.count({ where: { lotId: ids[0]! } })).toBe(1);
      await recordPayment(ctx.editor, p.orderId!, { amount: "900" });
      await releasePurchase(ctx.editor, p.id);
      expect(await db.pickTask.count({ where: { lotId: ids[0]!, status: "OPEN" } })).toBe(2);
    });
  });
});
