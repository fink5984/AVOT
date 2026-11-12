import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog } from "@/server/services/assignments";
import { createCustomer } from "@/server/services/customers";
import { recordSale, releasePurchase, recordPayment, cancelPurchase } from "@/server/services/sales";
import { pickItemTx, shipItemTx } from "@/server/services/picking";
import { mergeLots } from "@/server/services/lot-members";
import { addToShipment, cancelShipment, createShipment, customerBooks, deliverShipment, getShipment, packShipment, removeFromShipment, returnBook, shipShipment, shippingHint, shippingOverview, shipmentOfItem } from "@/server/services/shipments";
import { createWarehouse, createZone, createShelf } from "@/server/services/warehouse";
import { hasDb, makeOrg, createBook } from "./helpers";

describe.skipIf(!hasDb)("customer shipments (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("ship");
  });

  /** a customer who bought `n` lots (each its own book) in one new catalog; all released to picking */
  async function buyer(n: number, opts: { release?: boolean; catalogId?: string } = {}) {
    const catalog = opts.catalogId ? { id: opts.catalogId } : await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `H${++seq}-${Date.now() % 100000}`, name: "משלוחים" });
    const c = await createCustomer(ctx.editor, { name: `יצחק כהן ${seq}`, email: `c${seq}-${Date.now()}@example.com`, phone: `050-${String(Math.floor(Math.random() * 9e6 + 1e6))}`, addresses: [{ line1: "הרצל 1", city: "ירושלים", country: "ישראל" }] });
    const lots = [];
    for (let i = 0; i < n; i++) {
      const { item } = await createBook(ctx.editor, { title: `ספר ${seq}-${i + 1}` });
      const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id });
      const p = await recordSale(ctx.editor, { lotId: lot.id, customerId: c.id, hammerPrice: String(100 + i) });
      if (opts.release !== false) await releasePurchase(ctx.admin, p.id);
      lots.push({ lot, item, purchase: p });
    }
    return { c, lots, catalog };
  }
  /** the warehouse picks the book on the handheld */
  const pick = (itemId: string) => db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, itemId));
  const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; details?: { code?: string } }) => e.details?.code ?? e.code);

  it("a customer who bought ONE lot: a simple shipment, no warning; nothing is shipped until the books really leave", async () => {
    const { c, lots } = await buyer(1);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id] });
    expect(s.status).toBe("DRAFT");
    expect(s.recipient).toMatchObject({ name: c.name, address: expect.stringContaining("הרצל 1") });
    // creating the shipment did NOT ship the book
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })).physicalStatus).toBe("AWAITING_PICK");
    expect(await codeOf(shipShipment(ctx.editor, s.id))).toBe("CONFLICT"); // not packed
    expect(await codeOf(packShipment(ctx.editor, s.id))).toBe("NOT_PICKED"); // not picked yet
    await pick(lots[0]!.item.id);
    await packShipment(ctx.editor, s.id);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })).physicalStatus).toBe("PACKED");
    const sent = await shipShipment(ctx.editor, s.id, { carrier: "דואר", trackingNumber: "RR123", cost: "35.5" });
    expect(sent).toMatchObject({ status: "SHIPPED", trackingNumber: "RR123" });
    expect(sent.cost!.toFixed(2)).toBe("35.50");
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })).physicalStatus).toBe("SHIPPED");
    expect((await db.pickTask.findFirstOrThrow({ where: { inventoryItemId: lots[0]!.item.id } })).status).toBe("SHIPPED");
    expect((await deliverShipment(ctx.editor, s.id)).status).toBe("DELIVERED");
  });

  it("a customer who bought SIX lots: the hint shows the other five; shipping one asks for confirmation; the warning counts only what is really left", async () => {
    const { c, lots } = await buyer(6);
    const hint = await shippingHint(ctx.editor, { itemId: lots[0]!.item.id });
    expect(hint).toMatchObject({ otherLots: 5, otherBooks: 5, availableLots: 5, inOtherShipments: 0 });
    expect(hint!.customer!.id).toBe(c.id);

    const one = [lots[0]!.purchase.id];
    expect(await codeOf(createShipment(ctx.editor, { customerId: c.id, purchaseIds: one }))).toBe("PARTIAL_SHIPMENT");
    const err = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: one }).catch((e) => e);
    expect(err.details).toMatchObject({ remainingLots: 5, remainingBooks: 5 });
    // the person may go on with a partial shipment (it is not blocked) - but a warehouse worker may not approve it
    expect(await codeOf(createShipment(ctx.warehouse, { customerId: c.id, purchaseIds: one, confirmPartial: true }))).toBe("FORBIDDEN");
    const partial = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: one, confirmPartial: true });
    expect(partial.partialConfirmed).toBe(true);

    // a second shipment of three more: the warning now counts 2 left (one lot is in another shipment, so it is not "left behind" nor repeated)
    const err2 = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: lots.slice(1, 4).map((l) => l.purchase.id) }).catch((e) => e);
    expect(err2.details).toMatchObject({ remainingLots: 2 });
    // everything that is left goes together: no warning
    const rest = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: lots.slice(1).map((l) => l.purchase.id) });
    expect(rest.partialConfirmed).toBe(false);
    // several shipments for one customer
    expect(await db.shipment.count({ where: { customerId: c.id, status: "DRAFT" } })).toBe(2);
    // after the first one left, the hint no longer counts its book
    for (const l of lots) await pick(l.item.id);
    await packShipment(ctx.editor, partial.id);
    await shipShipment(ctx.editor, partial.id);
    const after = await shippingHint(ctx.editor, { itemId: lots[1]!.item.id });
    expect(after).toMatchObject({ otherLots: 4, inOtherShipments: 0, inSameShipment: 4 });
    const books = await customerBooks(db, ctx.org.id, c.id);
    expect(books).toHaveLength(5);
  });

  it("one shipment carries several lots; every book of a combined lot goes in; a book is never in two active shipments", async () => {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `M${++seq}-${Date.now() % 100000}`, name: "משולב" });
    const c = await createCustomer(ctx.editor, { name: "משולב לקוח", email: `mix${seq}@example.com` });
    const made = [];
    for (let i = 0; i < 3; i++) {
      const { item } = await createBook(ctx.editor, { title: `משולב ${i}` });
      made.push({ item, lot: await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id }) });
    }
    const ids = made.slice(0, 2).map((m) => m.lot.id);
    await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: ids, keepLotId: ids[0]! });
    const combined = await recordSale(ctx.editor, { lotId: ids[0]!, customerId: c.id, hammerPrice: "500" });
    const single = await recordSale(ctx.editor, { lotId: made[2]!.lot.id, customerId: c.id, hammerPrice: "50" });
    await releasePurchase(ctx.admin, combined.id);
    await releasePurchase(ctx.admin, single.id);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [combined.id, single.id] });
    const detail = await getShipment(ctx.editor, s.id);
    expect(detail.items.filter((i) => i.active)).toHaveLength(3); // 2 books of the combined lot + 1
    expect(new Set(detail.items.map((i) => i.lotId)).size).toBe(2);
    // the same book into a second shipment: refused, by the database too
    expect(await codeOf(createShipment(ctx.editor, { customerId: c.id, purchaseIds: [single.id], confirmPartial: true }))).toBe("ALREADY_IN_SHIPMENT");
    await expect(db.shipmentItem.create({ data: { organizationId: ctx.org.id, shipmentId: s.id, purchaseId: single.id, inventoryItemId: made[2]!.item.id } })).rejects.toThrow();
    // where is this book, and what else is in its shipment
    const where = await shipmentOfItem(ctx.org.id, made[0]!.item.id);
    expect(where).toMatchObject({ number: s.number, status: "DRAFT" });
    expect(where!.others).toHaveLength(2);
    // one scanned book of a combined lot does not make the shipment packed
    for (const m of made) await pick(m.item.id);
    await packShipment(ctx.editor, s.id);
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PACKED");
  });

  it("no shipment without a proper release: an unreleased sale cannot be put into a shipment", async () => {
    const { c, lots } = await buyer(2, { release: false });
    expect(await codeOf(createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id] }))).toBe("CONFLICT");
    const books = await customerBooks(db, ctx.org.id, c.id);
    expect(books.every((b) => !b.available && b.blockedReason?.includes("טרם"))).toBe(true);
    // paying releases nothing by itself; releasing after payment is a normal action
    await recordPayment(ctx.editor, lots[0]!.purchase.orderId!, { amount: "300" });
    await releasePurchase(ctx.editor, lots[0]!.purchase.id);
    expect((await customerBooks(db, ctx.org.id, c.id)).filter((b) => b.available)).toHaveLength(1);
    await releasePurchase(ctx.editor, lots[1]!.purchase.id);
    expect((await customerBooks(db, ctx.org.id, c.id)).filter((b) => b.available)).toHaveLength(2);
  });

  it("the handheld and the shipment screen share one truth: a book scanned out at the handheld moves its shipment", async () => {
    const { c, lots } = await buyer(2);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: lots.map((l) => l.purchase.id) });
    for (const l of lots) await pick(l.item.id);
    // the final removal at the handheld for both books → the shipment follows (it never stays "in preparation" with shipped books)
    for (const l of lots) await db.$transaction((tx) => shipItemTx(tx, ctx.warehouse, l.item.id));
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("SHIPPED");
    const overview = await shippingOverview(ctx.editor, {});
    expect(overview.rows.find((r) => r.customerId === c.id)).toBeUndefined(); // nothing waits any more
  });

  it("self pickup and hand delivery: leaving the warehouse is the hand-over", async () => {
    const { c, lots } = await buyer(1);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id], method: "PICKUP" });
    await pick(lots[0]!.item.id);
    await packShipment(ctx.editor, s.id);
    const done = await shipShipment(ctx.editor, s.id);
    expect(done.status).toBe("DELIVERED");
    expect(done.deliveredAt).toBeTruthy();
  });

  it("cancel a shipment before it leaves: the books return to the waiting list (picked again), nothing is deleted; a shipped one cannot be cancelled", async () => {
    const { c, lots } = await buyer(2);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: lots.map((l) => l.purchase.id) });
    for (const l of lots) await pick(l.item.id);
    await packShipment(ctx.editor, s.id);
    await cancelShipment(ctx.editor, s.id, "הלקוח ביקש לחכות");
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("CANCELLED");
    expect(await db.shipmentItem.count({ where: { shipmentId: s.id } })).toBe(2); // kept as history
    expect(await db.shipmentItem.count({ where: { shipmentId: s.id, isActive: true } })).toBe(0);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })).physicalStatus).toBe("PICKED");
    // they can be shipped in a new shipment
    const again = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: lots.map((l) => l.purchase.id) });
    await packShipment(ctx.editor, again.id);
    await shipShipment(ctx.editor, again.id);
    expect(await codeOf(cancelShipment(ctx.editor, again.id, "x"))).toBe("CONFLICT");
  });

  it("add to and remove from a shipment being prepared", async () => {
    const { c, lots } = await buyer(3);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id], confirmPartial: true });
    expect((await addToShipment(ctx.editor, s.id, [lots[1]!.purchase.id])).added).toBe(1);
    const r = await removeFromShipment(ctx.editor, s.id, lots[0]!.purchase.id, "בטעות");
    expect(r).toMatchObject({ removed: 1, shipmentCancelled: false });
    const d = await getShipment(ctx.editor, s.id);
    expect(d.items.filter((i) => i.active).map((i) => i.itemId)).toEqual([lots[1]!.item.id]);
    expect(d.items.find((i) => i.itemId === lots[0]!.item.id)).toMatchObject({ active: false, removeReason: "בטעות" });
  });

  it("a book returned after shipping: the shipment record stays, the book goes back to a shelf, the sale waits for a new release", async () => {
    const wh = await createWarehouse(ctx.admin, { code: "RW", name: "מחסן החזרות" });
    const zone = await createZone(ctx.admin, { warehouseId: wh.id, code: "C1", name: "עמודה" });
    const shelf = await createShelf(ctx.admin, { zoneId: zone.id, code: "01" });
    const loc = await db.storageLocation.findFirstOrThrow({ where: { shelfId: shelf.id } });
    const { c, lots } = await buyer(1);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id] });
    await pick(lots[0]!.item.id);
    await packShipment(ctx.editor, s.id);
    await shipShipment(ctx.editor, s.id);
    await returnBook(ctx.editor, s.id, lots[0]!.item.id, { reason: "הגיע פגום", condition: "פינה שבורה", locationId: loc.id });
    const book = await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } });
    expect(book).toMatchObject({ physicalStatus: "IN_STORAGE", currentLocationId: loc.id });
    const line = await db.shipmentItem.findFirstOrThrow({ where: { shipmentId: s.id } });
    expect(line).toMatchObject({ isActive: false, returnReason: "הגיע פגום", returnCondition: "פינה שבורה" });
    expect((await db.shipment.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("SHIPPED"); // the original shipment is not rewritten
    expect((await db.purchase.findUniqueOrThrow({ where: { id: lots[0]!.purchase.id } })).releasedAt).toBeNull();
    // now the deal can be cancelled safely (the book is back)
    await cancelPurchase(ctx.admin, lots[0]!.purchase.id, { reason: "החזרה" });
  });

  it("a shipped book blocks cancelling the deal until it is returned", async () => {
    const { c, lots } = await buyer(1);
    const s = await createShipment(ctx.editor, { customerId: c.id, purchaseIds: [lots[0]!.purchase.id] });
    await pick(lots[0]!.item.id);
    await packShipment(ctx.editor, s.id);
    await shipShipment(ctx.editor, s.id);
    expect(await codeOf(cancelPurchase(ctx.admin, lots[0]!.purchase.id, { reason: "x1" }))).toBe("CONFLICT");
  });

  it("the overview is per customer and keeps customers, lots, books and shipments apart", async () => {
    const a = await buyer(3);
    const b = await buyer(1, { release: false });
    const o = await shippingOverview(ctx.editor, {});
    const ra = o.rows.find((r) => r.customerId === a.c.id)!;
    expect(ra).toMatchObject({ waitingLots: 3, waitingBooks: 3, readyBooks: 3, openShipments: 0 });
    const rb = o.rows.find((r) => r.customerId === b.c.id)!;
    expect(rb).toMatchObject({ waitingLots: 1, readyBooks: 0, financial: "UNPAID" });
    expect(o.totals.customersBlockedByPayment).toBeGreaterThanOrEqual(1);
    const ready = await shippingOverview(ctx.editor, { onlyReady: true });
    expect(ready.rows.some((r) => r.customerId === b.c.id)).toBe(false);
  });
});
