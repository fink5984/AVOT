import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog, syncItemCommercial } from "@/server/services/assignments";
import { createCustomer } from "@/server/services/customers";
import { createPickTask, pickItemTx } from "@/server/services/picking";
import { recordSale, releasePurchase, cancelPurchase } from "@/server/services/sales";
import { mergeLots } from "@/server/services/lot-members";
import { attachLegacyCustomer, legacySaleBlockReason, markLegacySold, unmarkLegacySold } from "@/server/services/legacy-sales";
import { inventoryBreakdown, listInventory } from "@/server/services/inventory";
import { listSold, saleOfItem } from "@/server/services/sales-views";
import { createShipment, customerBooks, packShipment, shipShipment, shippingHint } from "@/server/services/shipments";
import { createShelf, createWarehouse, createZone, moveItemTx } from "@/server/services/warehouse";
import { hasDb, makeOrg, createBook } from "./helpers";

describe.skipIf(!hasDb)("active stock vs sold vs warehouse, and sales from the old system (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let loc: { id: string };
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("legacy");
    const wh = await createWarehouse(ctx.admin, { code: "LG", name: "מחסן א" });
    const zone = await createZone(ctx.admin, { warehouseId: wh.id, code: "C3", name: "עמודה 3" });
    const shelf = await createShelf(ctx.admin, { zoneId: zone.id, code: "05" });
    loc = await db.storageLocation.findFirstOrThrow({ where: { shelfId: shelf.id } });
  });

  /** a book on a shelf */
  async function shelved(title = `ספר ${++seq}`) {
    const { item } = await createBook(ctx.editor, { title });
    await db.$transaction((tx) => moveItemTx(tx, ctx.warehouse, item.id, loc.id, "STORE"));
    return item;
  }
  const row = (id: string) => db.inventoryItem.findUniqueOrThrow({ where: { id } });
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; details?: { code?: string } }) => e.details?.code ?? e.code);
  const inList = async (id: string, o: { includeSold?: boolean } = {}) => (await listInventory(ctx.editor, { pageSize: 500, ...o })).items.some((i) => i.id === id);

  it("marks a book sold in the old system: SOLD, a minimal purchase on the book, no price, no buyer, no lot or catalog, the shelf is untouched", async () => {
    const item = await shelved();
    const lots = await db.lot.count({ where: { organizationId: ctx.org.id } });
    const customers = await db.customer.count({ where: { organizationId: ctx.org.id } });
    const catalogs = await db.catalog.count({ where: { organizationId: ctx.org.id } });
    expect(await legacySaleBlockReason(db, ctx.org.id, item.id)).toBeNull();

    const r = await markLegacySold(ctx.editor, item.id);
    expect(r.created).toBe(true);
    expect(r.purchase).toMatchObject({ source: "LEGACY_MANUAL", status: "ACTIVE", lotId: null, catalogId: null, orderId: null, customerId: null, inventoryItemId: item.id });
    expect(r.purchase.hammerPrice).toBeNull(); // unknown - never 0
    const after = await row(item.id);
    expect(after).toMatchObject({ commercialStatus: "SOLD", physicalStatus: "IN_STORAGE", currentLocationId: loc.id });
    // nothing was invented
    expect(await db.lot.count({ where: { organizationId: ctx.org.id } })).toBe(lots);
    expect(await db.customer.count({ where: { organizationId: ctx.org.id } })).toBe(customers);
    expect(await db.catalog.count({ where: { organizationId: ctx.org.id } })).toBe(catalogs);
    // no pick task by itself
    expect(await db.pickTask.count({ where: { inventoryItemId: item.id } })).toBe(0);
    // history
    expect(await db.inventoryStatusEvent.count({ where: { inventoryItemId: item.id, dimension: "COMMERCIAL", toStatus: "SOLD" } })).toBe(1);
    expect(await db.saleEvent.count({ where: { purchaseId: r.purchase.id, kind: "LEGACY_MARKED" } })).toBe(1);
  });

  it("the sold book leaves the active inventory list, appears in 'נמכרו' as an old sale with unknown price and buyer, and stays on the shelf", async () => {
    const item = await shelved();
    expect(await inList(item.id)).toBe(true);
    await markLegacySold(ctx.editor, item.id);
    expect(await inList(item.id)).toBe(false);
    expect(await inList(item.id, { includeSold: true })).toBe(true); // reachable for handling / history
    const sold = await listSold(ctx.editor, { q: item.inventoryNumber });
    expect(sold.rows).toHaveLength(1);
    expect(sold.rows[0]).toMatchObject({ legacy: true, hammerPrice: null, customerId: null, lotId: null, catalogId: null, itemId: item.id, stage: "IN_WAREHOUSE", financial: "UNKNOWN" });
    expect(sold.rows[0]!.location).toContain("מדף 5");
    // the money totals are not touched by an unknown price
    expect(sold.summary).toMatchObject({ hammerTotal: "0.00", unknownPrice: 1, legacy: 1 });
    const shown = await saleOfItem(ctx.editor, item.id);
    expect(shown).toMatchObject({ legacy: true, customerName: null, hammerPrice: null });
    // the book page itself still opens (the record is not deleted)
    expect((await row(item.id)).title).toBe(item.title);
  });

  it("a double click and two parallel requests make ONE sale", async () => {
    const item = await shelved();
    const rs = await Promise.all([markLegacySold(ctx.editor, item.id), markLegacySold(ctx.editor, item.id), markLegacySold(ctx.admin, item.id)]);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.purchase.id)).size).toBe(1);
    expect(await db.purchase.count({ where: { inventoryItemId: item.id } })).toBe(1);
    expect(await db.saleEvent.count({ where: { purchaseId: rs[0]!.purchase.id, kind: "LEGACY_MARKED" } })).toBe(1);
    // the database itself refuses a second active one
    await expect(db.purchase.create({ data: { organizationId: ctx.org.id, inventoryItemId: item.id, source: "LEGACY_MANUAL" } })).rejects.toThrow();
  });

  it("an existing hand-made pick task ('נמכר') is kept as it is, linked to the sale, and no second task appears", async () => {
    const item = await shelved();
    const task = await createPickTask(ctx.editor, item.id, "נמכר", "הערה ידנית של המחסן");
    const r = await markLegacySold(ctx.editor, item.id);
    expect(await db.pickTask.count({ where: { inventoryItemId: item.id } })).toBe(1);
    const t = await db.pickTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t).toMatchObject({ reason: "נמכר", note: "הערה ידנית של המחסן", status: "OPEN", purchaseId: r.purchase.id });
    expect((await db.purchase.findUniqueOrThrow({ where: { id: r.purchase.id } })).releasedAt).not.toBeNull();
    expect((await row(item.id)).physicalStatus).toBe("AWAITING_PICK");
    const shown = await listSold(ctx.editor, { q: item.inventoryNumber });
    expect(shown.rows[0]).toMatchObject({ stage: "AWAITING_PICK", released: true });
    // a note that merely says 'sold' does not by itself make another book sold
    const other = await shelved();
    await createPickTask(ctx.editor, other.id, "נמכר");
    expect((await row(other.id)).commercialStatus).not.toBe("SOLD");
    expect(await inList(other.id)).toBe(true);
  });

  it("a book already picked keeps its picked state; a book that already left stays shipped and the mark cannot be taken back with one click", async () => {
    const picked = await shelved();
    await createPickTask(ctx.editor, picked.id, "נמכר");
    await db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, picked.id));
    await markLegacySold(ctx.editor, picked.id);
    expect((await row(picked.id)).physicalStatus).toBe("PICKED");
    expect((await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: picked.id } })).status).toBe("PICKED");
    expect((await listSold(ctx.editor, { q: picked.inventoryNumber })).rows[0]!.stage).toBe("PICKED");

    const gone = await shelved();
    await db.inventoryItem.update({ where: { id: gone.id }, data: { physicalStatus: "SHIPPED", currentLocationId: null } });
    const r = await markLegacySold(ctx.editor, gone.id);
    expect(r.created).toBe(true);
    expect((await row(gone.id)).physicalStatus).toBe("SHIPPED");
    expect((await listSold(ctx.editor, { q: gone.inventoryNumber })).rows[0]!.stage).toBe("SHIPPED");
    expect(await code(unmarkLegacySold(ctx.editor, r.purchase.id, { reason: "בטעות" }))).toBe("CONFLICT");
  });

  it("is refused when it would double or contradict a sale: a normal catalog sale, a book in an active catalog, an already sold book", async () => {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `LG${++seq}`, name: "קטלוג" });
    const inCatalog = await shelved();
    const lot = await assignToCatalog(ctx.editor, inCatalog.id, { catalogId: catalog.id });
    expect(await legacySaleBlockReason(db, ctx.org.id, inCatalog.id)).toContain("קטלוג");
    expect(await code(markLegacySold(ctx.editor, inCatalog.id))).toBe("LEGACY_NOT_ALLOWED");

    const c = await createCustomer(ctx.editor, { name: "קונה רגיל", email: `n${seq}-${Date.now()}@example.com` });
    await recordSale(ctx.editor, { lotId: lot.id, customerId: c.id, hammerPrice: "800" });
    expect(await legacySaleBlockReason(db, ctx.org.id, inCatalog.id)).toContain("נמכר");
    expect(await code(markLegacySold(ctx.editor, inCatalog.id))).toBe("LEGACY_NOT_ALLOWED");
    expect(await db.purchase.count({ where: { OR: [{ inventoryItemId: inCatalog.id }, { lotId: lot.id }], status: "ACTIVE" } })).toBe(1);

    const marked = await shelved();
    await markLegacySold(ctx.editor, marked.id);
    expect(await legacySaleBlockReason(db, ctx.org.id, marked.id)).toContain("נמכר");
  });

  it("a sold book cannot be put into a new catalog or a combined lot; a lot sync never turns it back into unassigned", async () => {
    const item = await shelved();
    await markLegacySold(ctx.editor, item.id);
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `LG${++seq}`, name: "קטלוג חדש" });
    expect(await code(assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id }))).toBe("CONFLICT");
    // the sync that follows every catalog / lot change keeps the sale
    await db.$transaction((tx) => syncItemCommercial(tx, ctx.editor, item.id, { reason: "בדיקת סנכרון" }));
    expect((await row(item.id)).commercialStatus).toBe("SOLD");
    // not offered in the picker of a catalog
    expect((await listInventory(ctx.editor, { notInCatalogId: catalog.id, pageSize: 500 })).items.some((i) => i.id === item.id)).toBe(false);
    // not joinable into a combined lot with another book
    const other = await shelved();
    const l1 = await assignToCatalog(ctx.editor, other.id, { catalogId: catalog.id });
    const mate = await shelved();
    const l2 = await assignToCatalog(ctx.editor, mate.id, { catalogId: catalog.id });
    expect(l1.id).not.toBe(l2.id);
    expect((await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: [l1.id, l2.id], keepLotId: l1.id })).lotId).toBe(l1.id);
  });

  it("takes a mistaken mark back: the sale stays as history, pick tasks and shelf are not touched, the book returns to active stock", async () => {
    const item = await shelved();
    const task = await createPickTask(ctx.editor, item.id, "נמכר");
    const r = await markLegacySold(ctx.editor, item.id);
    expect(await inList(item.id)).toBe(false);
    await unmarkLegacySold(ctx.editor, r.purchase.id, { reason: "סומן בטעות" });
    const p = await db.purchase.findUniqueOrThrow({ where: { id: r.purchase.id } });
    expect(p).toMatchObject({ status: "CANCELLED", cancelReason: "סומן בטעות", returnedToStock: true });
    expect(await row(item.id)).toMatchObject({ commercialStatus: "UNASSIGNED", physicalStatus: "AWAITING_PICK", currentLocationId: loc.id });
    const t = await db.pickTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t).toMatchObject({ status: "OPEN", purchaseId: null }); // the independent task is neither deleted nor changed
    expect(await inList(item.id)).toBe(true);
    expect(await db.saleEvent.count({ where: { purchaseId: r.purchase.id, kind: "LEGACY_UNMARKED" } })).toBe(1);
    expect(await code(unmarkLegacySold(ctx.editor, r.purchase.id, { reason: "שוב" }))).toBe("CONFLICT");
    // and it can be marked again, as a new sale
    const again = await markLegacySold(ctx.editor, item.id);
    expect(again.created).toBe(true);
    expect(again.purchase.id).not.toBe(r.purchase.id);
    // the general cancel action also routes a legacy sale to the same safe path
    await cancelPurchase(ctx.admin, again.purchase.id, { reason: "ביטול" });
    expect((await row(item.id)).commercialStatus).toBe("UNASSIGNED");
  });

  it("a buyer can be attached later; then the book is in the customer's books and joins a normal shipment; without a buyer no shipment can be made", async () => {
    const item = await shelved();
    const mate = await shelved();
    const r = await markLegacySold(ctx.editor, item.id);
    const c = await createCustomer(ctx.editor, { name: "דנה לוי", email: `dl${++seq}-${Date.now()}@example.com`, addresses: [{ line1: "הרצל 1", city: "חיפה", country: "ישראל" }] });
    // no buyer yet: cannot be shipped to anyone
    expect(await code(createShipment(ctx.editor, { customerId: c.id, purchaseIds: [r.purchase.id] }))).toBe("CONFLICT");
    await attachLegacyCustomer(ctx.editor, r.purchase.id, c.id);
    const books = await customerBooks(db, ctx.org.id, c.id);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ legacy: true, itemId: item.id, lotId: null, hammerPrice: null, released: false, available: false });
    expect(books[0]!.blockedReason).toContain("טרם שוחרר");

    // the customer also bought a normal lot: the smart hint sees the old-sale book as 'another waiting book'
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `LG${++seq}`, name: "קטלוג" });
    const lot = await assignToCatalog(ctx.editor, mate.id, { catalogId: catalog.id });
    const normal = await recordSale(ctx.editor, { lotId: lot.id, customerId: c.id, hammerPrice: "300" });
    await releasePurchase(ctx.admin, normal.id);
    const hint = await shippingHint(ctx.editor, { itemId: mate.id });
    expect(hint).toMatchObject({ otherLots: 1, otherBooks: 1 });
    // releasing the old sale: a task is created (none existed), no payment gate
    expect((await releasePurchase(ctx.warehouse, r.purchase.id)).released).toBe(true);
    expect((await releasePurchase(ctx.warehouse, r.purchase.id)).released).toBe(false); // twice = once
    expect(await db.pickTask.count({ where: { inventoryItemId: item.id } })).toBe(1);

    // one shipment with both: pick, pack, ship - the book leaves the physical stock
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [r.purchase.id, normal.id] });
    for (const id of [item.id, mate.id]) await db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, id));
    await packShipment(ctx.editor, s.id);
    const before = await inventoryBreakdown(ctx.org.id);
    await shipShipment(ctx.editor, s.id, { carrier: "דואר" });
    const out = await row(item.id);
    expect(out.physicalStatus).toBe("SHIPPED");
    // the shipped book keeps its record, its last place is in the movement history, and it stays in 'נמכרו' as shipped
    expect(await db.inventoryLocationMovement.count({ where: { inventoryItemId: item.id } })).toBeGreaterThan(0);
    const shown = (await listSold(ctx.editor, { customerId: c.id })).rows.find((x) => x.itemId === item.id)!;
    expect(shown).toMatchObject({ stage: "SHIPPED", legacy: true, customerId: c.id });
    expect((await listSold(ctx.editor, { customerId: c.id, stage: "DONE" })).rows).toHaveLength(2);
    expect((await listSold(ctx.editor, { customerId: c.id, stage: "OPEN" })).rows).toHaveLength(0);
    const after = await inventoryBreakdown(ctx.org.id);
    expect(after.shipped).toBe(before.shipped + 2);
    expect(after.physical).toBe(before.physical - 2);
    expect(after.soldBooks).toBe(before.soldBooks); // sold stays sold
    // a shipped book cannot be unmarked in one click
    expect(await code(unmarkLegacySold(ctx.editor, r.purchase.id, { reason: "בטעות" }))).toBe("CONFLICT");
  });

  it("counts: active stock, physical books, sold books by place, shipped, and lots apart from books (a combined lot is one lot, several books)", async () => {
    const o = await makeOrg("legacy-count");
    const wh = await createWarehouse(o.admin, { code: "CT", name: "מחסן" });
    const zone = await createZone(o.admin, { warehouseId: wh.id, code: "C1", name: "עמודה" });
    const shelf = await createShelf(o.admin, { zoneId: zone.id, code: "01" });
    const l = await db.storageLocation.findFirstOrThrow({ where: { shelfId: shelf.id } });
    const mk = async (t: string) => {
      const { item } = await createBook(o.editor, { title: t });
      await db.$transaction((tx) => moveItemTx(tx, o.warehouse, item.id, l.id, "STORE"));
      return item;
    };
    const free = [await mk("חופשי 1"), await mk("חופשי 2"), await mk("חופשי 3")];
    const legacyOnShelf = await mk("ישן על המדף");
    const legacyShipped = await mk("ישן שנשלח");
    await markLegacySold(o.editor, legacyOnShelf.id);
    await db.inventoryItem.update({ where: { id: legacyShipped.id }, data: { physicalStatus: "SHIPPED", currentLocationId: null } });
    await markLegacySold(o.editor, legacyShipped.id);
    // a normal combined lot of two books, sold
    const catalog = await createCatalog(o.editor, { auctionHouseId: o.house.id, number: "CNT1", name: "קטלוג" });
    const a = await mk("משולב א");
    const b = await mk("משולב ב");
    const la = await assignToCatalog(o.editor, a.id, { catalogId: catalog.id });
    const lb = await assignToCatalog(o.editor, b.id, { catalogId: catalog.id });
    const combined = await mergeLots(o.editor, { catalogId: catalog.id, lotIds: [la.id, lb.id], keepLotId: la.id });
    const c = await createCustomer(o.editor, { name: "קונה", email: `cnt-${Date.now()}@example.com` });
    await recordSale(o.editor, { lotId: combined.lotId, customerId: c.id, hammerPrice: "500" });

    const bk = await inventoryBreakdown(o.org.id);
    expect(bk).toMatchObject({
      active: free.length, // only the unsold books
      soldBooks: 4, // 2 legacy + the 2 books of the combined lot
      soldInHouse: 3, // legacy on shelf + 2 combined (not released yet)
      shipped: 1,
      soldLots: 3, // 2 legacy + ONE combined lot
      legacyLots: 2,
      physical: free.length + 3,
    });
    expect((await listInventory(o.editor, { pageSize: 500 })).items.map((i) => i.id).sort()).toEqual(free.map((i) => i.id).sort());
    const sold = await listSold(o.editor);
    expect(sold.summary).toMatchObject({ soldLots: 3, soldBooks: 4, hammerTotal: "500.00", unknownPrice: 2 });
  });

  it("permissions: marking is for admins and editors only; warehouse staff and viewers cannot", () => {
    expect(can("ADMIN", "sale.legacy")).toBe(true);
    expect(can("EDITOR", "sale.legacy")).toBe(true);
    expect(can("WAREHOUSE", "sale.legacy")).toBe(false);
    expect(can("VIEWER", "sale.legacy")).toBe(false);
    expect(can("PHOTOGRAPHER", "sale.legacy")).toBe(false);
  });
});
