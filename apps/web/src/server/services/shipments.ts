import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { canSeeHouse } from "../auth/houses";
import { canUser } from "../auth/permissions";
import { asJson } from "../json";
import { parseUsd } from "@/lib/money";
import { changeStatus } from "./item-status";
import { moveItemTx } from "./warehouse";
import { orderLedger, stageOf, purchaseItemIds, purchaseName, type Stage } from "./sales";
import { memberItemIds } from "./lot-members";
import type { Address } from "./customers";

/*
 * Shipments are per CUSTOMER: one shipment may carry several lots and books, a customer may have several shipments.
 * A book is in at most one ACTIVE shipment (database index). Creating a shipment reserves books, it never marks anything
 * shipped: SHIPPED is written only when the books physically leave, and it goes through the same pick tasks and book
 * statuses the warehouse and the handheld already use - one source of truth.
 */

export const SHIPMENT_LABEL: Record<string, string> = { DRAFT: "בהכנה", PACKED: "נארז", SHIPPED: "נשלח", DELIVERED: "נמסר", CANCELLED: "בוטל" };

/* ───────────────────────── what a customer is waiting for ───────────────────────── */

export interface WaitingBook {
  purchaseId: string;
  /** a sale from the old system has no lot, catalog or house */
  legacy: boolean;
  lotId: string | null;
  lotNumber: number | null;
  catalogId: string | null;
  catalogNumber: string | null;
  house: string | null;
  itemId: string;
  inventoryNumber: string;
  title: string;
  hammerPrice: string | null;
  released: boolean;
  financial: string;
  stage: Stage;
  /** can be put into a new shipment right now */
  available: boolean;
  /** why not, when it cannot */
  blockedReason: string | null;
  shipmentId: string | null;
  shipmentStatus: string | null;
}

/**
 * Every physical book the customer bought (active purchases) that has not gone out yet, with whether it can join a
 * shipment now. Used by "נמכרו", the customer card, the handheld and the shipment screens.
 */
export async function customerBooks(tx: Tx | typeof db, orgId: string, customerId: string, opts: { includeShipped?: boolean } = {}): Promise<WaitingBook[]> {
  const purchases = await tx.purchase.findMany({
    where: { organizationId: orgId, customerId, status: "ACTIVE" },
    include: { lot: true, catalog: { include: { auctionHouse: { select: { name: true } } } }, item: { select: { id: true, inventoryNumber: true, title: true, physicalStatus: true } } },
    orderBy: [{ catalog: { saleDate: "asc" } }, { lot: { lotNumber: "asc" } }, { createdAt: "asc" }],
  });
  if (!purchases.length) return [];
  const lotMembers = await tx.lotMember.findMany({
    where: { lotId: { in: purchases.map((p) => p.lotId).filter((x): x is string => !!x) }, removedAt: null },
    orderBy: { sortOrder: "asc" },
    include: { item: { select: { id: true, inventoryNumber: true, title: true, physicalStatus: true } } },
  });
  // the books of a purchase: the members of its lot, or the one book a legacy sale hangs on
  const members = [
    ...lotMembers.map((m) => ({ purchaseKey: m.lotId, lotId: m.lotId as string | null, inventoryItemId: m.inventoryItemId, item: m.item })),
    ...purchases.filter((p) => !p.lotId && p.item).map((p) => ({ purchaseKey: p.id, lotId: null as string | null, inventoryItemId: p.item!.id, item: p.item! })),
  ];
  const itemIds = members.map((m) => m.inventoryItemId);
  const shipItems = await tx.shipmentItem.findMany({ where: { inventoryItemId: { in: itemIds }, isActive: true }, include: { shipment: { select: { id: true, status: true } } } });
  const orders = [...new Set(purchases.map((p) => p.orderId).filter((x): x is string => !!x))];
  const ledgers = new Map<string, Awaited<ReturnType<typeof orderLedger>>>();
  for (const o of orders) ledgers.set(o, await orderLedger(tx, o));
  const out: WaitingBook[] = [];
  for (const p of purchases) {
    const fin = p.orderId ? (ledgers.get(p.orderId)!.purchases.find((x) => x.id === p.id)?.status ?? "NONE") : "UNKNOWN";
    for (const m of members.filter((x) => x.purchaseKey === (p.lotId ?? p.id))) {
      const si = shipItems.find((s) => s.inventoryItemId === m.inventoryItemId);
      const delivered = si?.shipment.status === "DELIVERED";
      const stage = stageOf([{ physicalStatus: m.item.physicalStatus, delivered }]);
      const gone = m.item.physicalStatus === "SHIPPED";
      if (gone && !opts.includeShipped) continue;
      let reason: string | null = null;
      if (gone) reason = "כבר נשלח";
      else if (si) reason = "כבר משויך למשלוח";
      else if (!p.releasedAt) reason = fin === "PAID" || fin === "UNKNOWN" ? "טרם שוחרר לליקוט" : "טרם שולם ולא שוחרר לליקוט";
      else if (m.item.physicalStatus === "MISSING") reason = "הספר מסומן כחסר";
      out.push({
        purchaseId: p.id,
        legacy: !p.lotId,
        lotId: p.lotId,
        lotNumber: p.lot?.lotNumber ?? null,
        catalogId: p.catalogId,
        catalogNumber: p.catalog?.number ?? null,
        house: p.catalog?.auctionHouse.name ?? null,
        itemId: m.item.id,
        inventoryNumber: m.item.inventoryNumber,
        title: m.item.title,
        hammerPrice: p.hammerPrice?.toFixed(2) ?? null,
        released: !!p.releasedAt,
        financial: fin,
        stage,
        available: reason === null,
        blockedReason: reason,
        shipmentId: si?.shipment.id ?? null,
        shipmentStatus: si?.shipment.status ?? null,
      });
    }
  }
  return out;
}

/** the books of a customer for a user: payment states are removed for people without access to financial data */
export async function customerBooksFor(user: UserPrincipal): Promise<(customerId: string) => Promise<WaitingBook[]>> {
  const seeMoney = canUser(user, "sales.view");
  return async (customerId) => {
    const books = await customerBooks(db, user.organizationId, customerId);
    return seeMoney ? books : books.map((b) => ({ ...b, financial: "HIDDEN", blockedReason: b.blockedReason?.replace("טרם שולם ולא שוחרר לליקוט", "טרם שוחרר לליקוט") ?? null }));
  };
}

/** the smart-shipping hint for one purchase/book: what else the same customer is waiting for */
export async function shippingHint(user: UserPrincipal, opts: { purchaseId?: string; itemId?: string }) {
  let purchaseId = opts.purchaseId;
  if (!purchaseId && opts.itemId) {
    const m = await db.lotMember.findFirst({ where: { inventoryItemId: opts.itemId, removedAt: null, lot: { purchases: { some: { status: "ACTIVE" } } } }, select: { lotId: true } });
    const p = await db.purchase.findFirst({ where: m ? { lotId: m.lotId, status: "ACTIVE" } : { inventoryItemId: opts.itemId, lotId: null, status: "ACTIVE" }, select: { id: true } });
    purchaseId = p?.id;
  }
  if (!purchaseId) return null;
  const p = await db.purchase.findFirst({ where: { id: purchaseId, organizationId: user.organizationId }, include: { customer: { select: { id: true, name: true, number: true } } } });
  if (!p) throw notFound("הרכישה");
  if (!p.customerId) return null;
  const books = await customerBooks(db, user.organizationId, p.customerId);
  const mine = books.filter((b) => b.purchaseId === p.id);
  const mineShipments = new Set(mine.map((b) => b.shipmentId).filter((x): x is string => !!x));
  const others = books.filter((b) => b.purchaseId !== p.id);
  const lots = (xs: WaitingBook[]) => new Set(xs.map((x) => x.purchaseId)).size;
  return {
    customer: p.customer,
    otherLots: lots(others),
    otherBooks: others.length,
    availableLots: lots(others.filter((b) => b.available)),
    availableBooks: others.filter((b) => b.available).length,
    /** other lots already planned in a DIFFERENT shipment (the same shipment is not "other") */
    inOtherShipments: lots(others.filter((b) => b.shipmentId && !mineShipments.has(b.shipmentId))),
    inSameShipment: lots(others.filter((b) => b.shipmentId && mineShipments.has(b.shipmentId))),
    blockedLots: lots(others.filter((b) => !b.available && !b.shipmentId)),
    /** other lots that need nothing more: ready to join a shipment now */
    others,
  };
}

/* ───────────────────────── creating & changing ───────────────────────── */

async function nextShipmentNumber(tx: Tx, orgId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"shipment:" + orgId}))`;
  const agg = await tx.shipment.aggregate({ where: { organizationId: orgId }, _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

export const createShipmentSchema = z.object({
  customerId: z.string().uuid(),
  /** the lots (purchases) to ship: every physical book of each lot goes together */
  purchaseIds: z.array(z.string().uuid()).min(1, "יש לבחור לפחות לוט אחד").max(500),
  method: z.enum(["CARRIER", "PICKUP", "HAND_DELIVERY"]).default("CARRIER"),
  carrier: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  /** the person agrees to send only part of what the customer is waiting for */
  confirmPartial: z.boolean().optional(),
  /** recipient override; default = the customer's name, phone and first address */
  recipient: z.object({ name: z.string().trim().max(200).optional(), phone: z.string().trim().max(60).optional(), address: z.string().trim().max(600).optional() }).optional(),
});

async function visibleHouse(user: UserPrincipal, catalogId: string) {
  const c = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId }, select: { auctionHouseId: true } });
  return !!c && canSeeHouse(user, c.auctionHouseId);
}

function partialError(left: WaitingBook[]) {
  const lots = new Set(left.map((b) => b.lotId)).size;
  return new AppError("CONFLICT", `אתה עומד לשלוח חלק מהרכישות: ללקוח יש עוד ${lots} לוטים שעדיין לא נשלחו`, {
    code: "PARTIAL_SHIPMENT",
    remainingLots: lots,
    remainingBooks: left.length,
    available: left.filter((b) => b.available).length,
  });
}

/** books of the customer that stay behind if THIS shipment goes alone (books in other active shipments and shipped books do not count) */
async function leftBehind(tx: Tx | typeof db, orgId: string, customerId: string, shipmentItemIds: Set<string>) {
  const all = await customerBooks(tx, orgId, customerId);
  return all.filter((b) => !shipmentItemIds.has(b.itemId) && !b.shipmentId);
}

export async function createShipment(user: UserPrincipal, raw: z.input<typeof createShipmentSchema>) {
  const input = createShipmentSchema.parse(raw);
  const customer = await db.customer.findFirst({ where: { id: input.customerId, organizationId: user.organizationId, status: "ACTIVE" } });
  if (!customer) throw notFound("הלקוח");
  return db.$transaction(async (tx) => {
    const purchases = await tx.purchase.findMany({ where: { id: { in: input.purchaseIds }, organizationId: user.organizationId, customerId: customer.id, status: "ACTIVE" }, include: { lot: true } });
    if (purchases.length !== new Set(input.purchaseIds).size) throw new AppError("CONFLICT", "חלק מהרכישות אינן פעילות או אינן של הלקוח");
    for (const p of purchases) if (p.catalogId && !(await visibleHouse(user, p.catalogId))) throw new AppError("FORBIDDEN", "אין הרשאה לרכישה מבית מכירות אחר");
    const itemIds: { purchaseId: string; itemId: string }[] = [];
    for (const p of purchases) {
      if (!p.releasedAt) throw new AppError("CONFLICT", `${purchaseName(p)} טרם שוחרר לליקוט - לא ניתן לצרף אותו למשלוח`);
      for (const id of await purchaseItemIds(tx, p)) itemIds.push({ purchaseId: p.id, itemId: id });
    }
    const ids = itemIds.map((x) => x.itemId).sort();
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const items = await tx.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, inventoryNumber: true, physicalStatus: true } });
    for (const it of items) {
      if (it.physicalStatus === "SHIPPED") throw new AppError("CONFLICT", `הספר ${it.inventoryNumber} כבר נשלח`);
      const taken = await tx.shipmentItem.findFirst({ where: { inventoryItemId: it.id, isActive: true }, include: { shipment: { select: { number: true } } } });
      if (taken) throw new AppError("CONFLICT", `הספר ${it.inventoryNumber} כבר משויך למשלוח ${taken.shipment.number}`, { code: "ALREADY_IN_SHIPMENT", shipmentId: taken.shipmentId });
    }
    const left = await leftBehind(tx, user.organizationId, customer.id, new Set(ids));
    if (left.length && !input.confirmPartial) throw partialError(left);
    if (left.length && !canUser(user, "shipment.partial")) throw new AppError("FORBIDDEN", "אין הרשאה לאשר משלוח חלקי");

    const addr = (customer.addresses as Address[])[0];
    const recipient = {
      name: input.recipient?.name ?? addr?.name ?? customer.name,
      phone: input.recipient?.phone ?? customer.phone ?? null,
      address: input.recipient?.address ?? (addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country].filter(Boolean).join(", ") : null),
      email: customer.email ?? null,
    };
    const s = await tx.shipment.create({
      data: {
        organizationId: user.organizationId,
        number: await nextShipmentNumber(tx, user.organizationId),
        customerId: customer.id,
        method: input.method,
        carrier: input.carrier ?? null,
        notes: input.notes ?? null,
        recipient: asJson(recipient),
        partialConfirmed: left.length > 0,
        createdById: user.userId,
      },
    });
    await tx.shipmentItem.createMany({ data: itemIds.map((x) => ({ organizationId: user.organizationId, shipmentId: s.id, purchaseId: x.purchaseId, inventoryItemId: x.itemId, addedById: user.userId })) });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId: s.id, customerId: customer.id, kind: "SHIPMENT_CREATED", data: asJson({ number: s.number, lots: purchases.length, books: itemIds.length, partial: left.length > 0, leftBehindLots: new Set(left.map((b) => b.lotId)).size }), userId: user.userId } });
    await audit(user, { action: "shipment.created", entityType: "pick", entityId: s.id, data: asJson({ number: s.number, books: itemIds.length }) }, tx);
    return s;
  });
}

async function loadShipment(user: UserPrincipal, id: string) {
  const s = await db.shipment.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!s) throw notFound("המשלוח");
  return s;
}

/** Adds the books of more lots to a shipment that is still being prepared. */
export async function addToShipment(user: UserPrincipal, shipmentId: string, purchaseIds: string[]) {
  const s = await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const cur = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (cur.status !== "DRAFT") throw new AppError("CONFLICT", "אפשר להוסיף פריטים רק למשלוח שבהכנה");
    const purchases = await tx.purchase.findMany({ where: { id: { in: purchaseIds }, organizationId: user.organizationId, customerId: s.customerId, status: "ACTIVE" }, include: { lot: true } });
    if (purchases.length !== new Set(purchaseIds).size) throw new AppError("CONFLICT", "חלק מהרכישות אינן פעילות או אינן של הלקוח");
    let added = 0;
    for (const p of purchases) {
      if (!p.releasedAt) throw new AppError("CONFLICT", `${purchaseName(p)} טרם שוחרר לליקוט`);
      for (const itemId of await purchaseItemIds(tx, p)) {
        await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
        const it = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { inventoryNumber: true, physicalStatus: true } });
        if (it.physicalStatus === "SHIPPED") throw new AppError("CONFLICT", `הספר ${it.inventoryNumber} כבר נשלח`);
        const taken = await tx.shipmentItem.findFirst({ where: { inventoryItemId: itemId, isActive: true } });
        if (taken) {
          if (taken.shipmentId === shipmentId) continue;
          throw new AppError("CONFLICT", `הספר ${it.inventoryNumber} כבר משויך למשלוח אחר`, { code: "ALREADY_IN_SHIPMENT", shipmentId: taken.shipmentId });
        }
        await tx.shipmentItem.create({ data: { organizationId: user.organizationId, shipmentId, purchaseId: p.id, inventoryItemId: itemId, addedById: user.userId } });
        added += 1;
      }
    }
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, kind: "SHIPMENT_ITEMS_ADDED", data: asJson({ books: added }), userId: user.userId } });
    return { added };
  });
}

/** Takes a whole lot out of a shipment that has not left yet (its books stay with the customer's waiting list). */
export async function removeFromShipment(user: UserPrincipal, shipmentId: string, purchaseId: string, reason?: string) {
  const s = await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const cur = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (cur.status !== "DRAFT" && cur.status !== "PACKED") throw new AppError("CONFLICT", "אי אפשר להוציא פריטים ממשלוח שכבר יצא");
    const rows = await tx.shipmentItem.findMany({ where: { shipmentId, purchaseId, isActive: true } });
    if (!rows.length) throw notFound("הפריט במשלוח");
    for (const r of rows) await unpackTx(tx, user, r.inventoryItemId);
    await tx.shipmentItem.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { isActive: false, removedAt: new Date(), removedById: user.userId, removeReason: reason ?? "הוצא מהמשלוח" } });
    const left = await tx.shipmentItem.count({ where: { shipmentId, isActive: true } });
    if (!left) await tx.shipment.update({ where: { id: shipmentId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: user.userId, cancelReason: "כל הפריטים הוצאו" } });
    else await recomputeStatusTx(tx, user, shipmentId);
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, purchaseId, kind: "SHIPMENT_ITEM_REMOVED", data: asJson({ books: rows.length, reason: reason ?? null }), userId: user.userId } });
    return { removed: rows.length, shipmentCancelled: !left };
  });
}

/** a book that was packed goes back to "picked" when its shipment line is removed */
async function unpackTx(tx: Tx, principal: Principal, itemId: string) {
  const task = await tx.pickTask.findFirst({ where: { inventoryItemId: itemId, status: "PACKED" } });
  if (!task) return;
  await tx.pickTask.update({ where: { id: task.id }, data: { status: "PICKED", packedAt: null, packedById: null } });
  await changeStatus(tx, principal, itemId, "PHYSICAL", "PICKED", { refType: "pick", refId: task.id, reason: "הוצא ממשלוח" });
}

/* ───────────────────────── steps: pack, ship, deliver ───────────────────────── */

/**
 * Brings the shipment's status in line with what physically happened to its books. The warehouse screens, the handheld and the
 * shipment screens all call this after they change a book, so the shipment never disagrees with the shelf.
 */
export async function recomputeStatusTx(tx: Tx, principal: Principal, shipmentId: string) {
  const s = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!s || s.status === "CANCELLED" || s.status === "DELIVERED") return s;
  const items = await tx.shipmentItem.findMany({ where: { shipmentId, isActive: true }, include: { item: { select: { physicalStatus: true } } } });
  if (!items.length) return s;
  const all = (pred: (st: string) => boolean) => items.every((i) => pred(i.item.physicalStatus));
  let next = s.status;
  if (all((st) => st === "SHIPPED")) next = "SHIPPED";
  else if (s.status !== "SHIPPED" && all((st) => st === "PACKED" || st === "SHIPPED")) next = "PACKED";
  else if (s.status === "PACKED" && !all((st) => st === "PACKED" || st === "SHIPPED")) next = "DRAFT";
  if (next === s.status) return s;
  const now = new Date();
  const by = principal.kind === "user" ? principal.userId : null;
  const data: Prisma.ShipmentUncheckedUpdateInput = { status: next };
  if (next === "PACKED") Object.assign(data, { packedAt: s.packedAt ?? now, packedById: s.packedById ?? by });
  if (next === "SHIPPED") {
    Object.assign(data, { packedAt: s.packedAt ?? now, shippedAt: s.shippedAt ?? now, shippedById: s.shippedById ?? by });
    // pickup / hand delivery: leaving the warehouse IS the hand-over
    if (s.method !== "CARRIER") Object.assign(data, { status: "DELIVERED", deliveredAt: now, deliveredById: by });
  }
  const u = await tx.shipment.update({ where: { id: shipmentId }, data });
  await tx.saleEvent.create({ data: { organizationId: s.organizationId, shipmentId, customerId: s.customerId, kind: `SHIPMENT_${String(u.status)}`, data: asJson({ via: "sync" }), userId: by } });
  return u;
}

/** called by the warehouse / handheld flows after a book's physical status changed */
export async function syncShipmentsOfItem(tx: Tx, principal: Principal, itemId: string) {
  const rows = await tx.shipmentItem.findMany({ where: { inventoryItemId: itemId, isActive: true }, select: { shipmentId: true } });
  for (const r of rows) await recomputeStatusTx(tx, principal, r.shipmentId);
}

export async function packShipment(user: UserPrincipal, shipmentId: string) {
  await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (s.status !== "DRAFT") throw new AppError("CONFLICT", s.status === "PACKED" ? "המשלוח כבר נארז" : "המשלוח אינו בהכנה");
    const items = await tx.shipmentItem.findMany({ where: { shipmentId, isActive: true }, include: { item: { select: { inventoryNumber: true, physicalStatus: true } } } });
    const notPicked = items.filter((i) => !["PICKED", "PACKED"].includes(i.item.physicalStatus));
    if (notPicked.length) throw new AppError("CONFLICT", `לא ניתן לארוז: ${notPicked.length} ספרים עוד לא לוקטו (${notPicked.slice(0, 3).map((i) => i.item.inventoryNumber).join(", ")}${notPicked.length > 3 ? "…" : ""})`, { code: "NOT_PICKED", count: notPicked.length });
    const now = new Date();
    for (const i of items) {
      const task = await tx.pickTask.findFirst({ where: { inventoryItemId: i.inventoryItemId, status: "PICKED" } });
      if (!task) continue;
      await tx.pickTask.update({ where: { id: task.id }, data: { status: "PACKED", packedAt: now, packedById: user.userId } });
      await changeStatus(tx, user, i.inventoryItemId, "PHYSICAL", "PACKED", { refType: "pick", refId: task.id, reason: `משלוח ${s.number}` });
    }
    await tx.shipment.update({ where: { id: shipmentId }, data: { status: "PACKED", packedAt: now, packedById: user.userId } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, kind: "SHIPMENT_PACKED", userId: user.userId } });
    return { packed: items.length };
  });
}

export const shipSchema = z.object({
  carrier: z.string().trim().max(120).nullish(),
  trackingNumber: z.string().trim().max(120).nullish(),
  cost: z.union([z.string(), z.number()]).nullish(),
  confirmPartial: z.boolean().optional(),
});

/** The books leave. Only a PACKED shipment can be sent; a partial shipment needs the person's confirmation. */
export async function shipShipment(user: UserPrincipal, shipmentId: string, raw: z.input<typeof shipSchema> = {}) {
  const input = shipSchema.parse(raw);
  let cost: string | null = null;
  try {
    cost = input.cost === undefined || input.cost === null ? null : parseUsd(input.cost, { allowZero: true });
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }
  await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (s.status === "DRAFT") throw new AppError("CONFLICT", "יש לארוז את המשלוח לפני השליחה");
    if (s.status !== "PACKED") throw new AppError("CONFLICT", s.status === "CANCELLED" ? "המשלוח בוטל" : "המשלוח כבר נשלח");
    const items = await tx.shipmentItem.findMany({ where: { shipmentId, isActive: true }, include: { purchase: true } });
    for (const i of items) {
      if (!i.purchase.releasedAt || i.purchase.status !== "ACTIVE") throw new AppError("CONFLICT", "אחת הרכישות במשלוח אינה משוחררת או בוטלה");
    }
    if (!s.partialConfirmed) {
      const left = await leftBehind(tx, user.organizationId, s.customerId, new Set(items.map((i) => i.inventoryItemId)));
      if (left.length) {
        if (!input.confirmPartial) throw partialError(left);
        if (!canUser(user, "shipment.partial")) throw new AppError("FORBIDDEN", "אין הרשאה לאשר משלוח חלקי");
      }
    }
    const now = new Date();
    for (const i of items) {
      const task = await tx.pickTask.findFirst({ where: { inventoryItemId: i.inventoryItemId, status: "PACKED" } });
      if (task) await tx.pickTask.update({ where: { id: task.id }, data: { status: "SHIPPED", shippedAt: now, shippedById: user.userId } });
      await changeStatus(tx, user, i.inventoryItemId, "PHYSICAL", "SHIPPED", { refType: "shipment", refId: shipmentId, reason: `משלוח ${s.number}` });
    }
    const handOver = s.method !== "CARRIER";
    const u = await tx.shipment.update({
      where: { id: shipmentId },
      data: {
        status: handOver ? "DELIVERED" : "SHIPPED",
        shippedAt: now,
        shippedById: user.userId,
        ...(handOver ? { deliveredAt: now, deliveredById: user.userId } : {}),
        carrier: input.carrier ?? s.carrier,
        trackingNumber: input.trackingNumber ?? s.trackingNumber,
        cost: cost === null ? s.cost : new Prisma.Decimal(cost),
        partialConfirmed: s.partialConfirmed || !!input.confirmPartial,
      },
    });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, kind: handOver ? "SHIPMENT_HANDED_OVER" : "SHIPMENT_SHIPPED", data: asJson({ books: items.length, tracking: u.trackingNumber }), userId: user.userId } });
    await audit(user, { action: "shipment.shipped", entityType: "pick", entityId: shipmentId, data: asJson({ number: s.number, books: items.length }) }, tx);
    return u;
  });
}

export async function deliverShipment(user: UserPrincipal, shipmentId: string) {
  await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const r = await tx.shipment.updateMany({ where: { id: shipmentId, status: "SHIPPED" }, data: { status: "DELIVERED", deliveredAt: new Date(), deliveredById: user.userId } });
    if (!r.count) throw new AppError("CONFLICT", "רק משלוח שנשלח יכול להיות מסומן כנמסר");
    const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, kind: "SHIPMENT_DELIVERED", userId: user.userId } });
    return s;
  });
}

/** Cancels a shipment that has not left. The books stay reserved for nobody and go back to the customer's waiting list. */
export async function cancelShipment(user: UserPrincipal, shipmentId: string, reason: string) {
  if (!reason?.trim()) throw new AppError("VALIDATION", "יש לציין סיבת ביטול");
  await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const s = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (s.status === "SHIPPED" || s.status === "DELIVERED") throw new AppError("CONFLICT", "המשלוח כבר יצא. אפשר לרשום החזרה של ספר, לא לבטל את המשלוח");
    if (s.status === "CANCELLED") throw new AppError("CONFLICT", "המשלוח כבר בוטל");
    const items = await tx.shipmentItem.findMany({ where: { shipmentId, isActive: true } });
    for (const i of items) await unpackTx(tx, user, i.inventoryItemId);
    await tx.shipmentItem.updateMany({ where: { shipmentId, isActive: true }, data: { isActive: false, removedAt: new Date(), removedById: user.userId, removeReason: "המשלוח בוטל" } });
    const u = await tx.shipment.update({ where: { id: shipmentId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: user.userId, cancelReason: reason.trim() } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, customerId: s.customerId, kind: "SHIPMENT_CANCELLED", data: asJson({ reason: reason.trim() }), userId: user.userId } });
    return u;
  });
}

export const returnSchema = z.object({
  reason: z.string().trim().min(2, "יש לציין סיבה").max(500),
  condition: z.string().trim().max(300).nullish(),
  locationId: z.string().uuid().nullish(),
});

/**
 * A book comes back after it was sent / delivered. The original shipment record is untouched (the line is marked
 * returned), the book returns to a shelf, and the sale goes back to "waiting for release" so nothing is shipped again by accident.
 */
export async function returnBook(user: UserPrincipal, shipmentId: string, itemId: string, raw: z.input<typeof returnSchema>) {
  const input = returnSchema.parse(raw);
  await loadShipment(user, shipmentId);
  return db.$transaction(async (tx) => {
    const line = await tx.shipmentItem.findFirst({ where: { shipmentId, inventoryItemId: itemId, returnedAt: null }, include: { shipment: true } });
    if (!line) throw notFound("הספר במשלוח");
    if (!["SHIPPED", "DELIVERED"].includes(line.shipment.status)) throw new AppError("CONFLICT", "אפשר להחזיר רק ספר ממשלוח שיצא");
    if (input.locationId) {
      const loc = await tx.storageLocation.findFirst({ where: { id: input.locationId, organizationId: user.organizationId, active: true } });
      if (!loc) throw notFound("המדף");
    }
    await tx.shipmentItem.update({ where: { id: line.id }, data: { isActive: false, returnedAt: new Date(), returnedById: user.userId, returnReason: input.reason, returnCondition: input.condition ?? null, returnLocationId: input.locationId ?? null } });
    if (input.locationId) await moveItemTx(tx, user, itemId, input.locationId, "RETURN", { note: `החזרה ממשלוח ${line.shipment.number}: ${input.reason}` });
    else await changeStatus(tx, user, itemId, "PHYSICAL", "AWAITING_STORAGE", { refType: "shipment", refId: shipmentId, reason: `החזרה: ${input.reason}` });
    // the sale waits for a new release (and payment status stays as it is)
    await tx.purchase.update({ where: { id: line.purchaseId }, data: { releasedAt: null, releasedById: null, releasedUnpaid: false, releaseNote: `הספר הוחזר (${input.reason})` } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, shipmentId, purchaseId: line.purchaseId, customerId: line.shipment.customerId, kind: "BOOK_RETURNED", data: asJson({ itemId, reason: input.reason, condition: input.condition ?? null, locationId: input.locationId ?? null }), userId: user.userId } });
    await audit(user, { action: "shipment.book_returned", entityType: "pick", entityId: shipmentId, inventoryItemId: itemId, data: asJson({ reason: input.reason }) }, tx);
    return { returned: true };
  });
}

/* ───────────────────────── read models ───────────────────────── */

export async function getShipment(user: UserPrincipal, id: string) {
  const s = await db.shipment.findFirst({ where: { id, organizationId: user.organizationId }, include: { customer: { select: { id: true, name: true, number: true } } } });
  if (!s) throw notFound("המשלוח");
  const items = await db.shipmentItem.findMany({
    where: { shipmentId: id },
    orderBy: { addedAt: "asc" },
    include: { item: { select: { id: true, inventoryNumber: true, title: true, physicalStatus: true, primaryAssetId: true } }, purchase: { select: { id: true, hammerPrice: true, lot: { select: { id: true, lotNumber: true, catalog: { select: { number: true } } } } } } },
  });
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    method: s.method,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    cost: s.cost?.toFixed(2) ?? null,
    recipient: s.recipient as { name: string; phone: string | null; address: string | null; email: string | null },
    notes: s.notes,
    partialConfirmed: s.partialConfirmed,
    customer: s.customer,
    createdAt: s.createdAt.toISOString(),
    packedAt: s.packedAt?.toISOString() ?? null,
    shippedAt: s.shippedAt?.toISOString() ?? null,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    cancelledAt: s.cancelledAt?.toISOString() ?? null,
    cancelReason: s.cancelReason,
    items: items.map((i) => ({
      id: i.id,
      active: i.isActive,
      itemId: i.item.id,
      inventoryNumber: i.item.inventoryNumber,
      title: i.item.title,
      thumbAssetId: i.item.primaryAssetId,
      physicalStatus: i.item.physicalStatus,
      lotId: i.purchase.lot?.id ?? null,
      lotNumber: i.purchase.lot?.lotNumber ?? null,
      catalogNumber: i.purchase.lot?.catalog.number ?? null,
      legacy: !i.purchase.lot,
      purchaseId: i.purchase.id,
      removedAt: i.removedAt?.toISOString() ?? null,
      removeReason: i.removeReason,
      returnedAt: i.returnedAt?.toISOString() ?? null,
      returnReason: i.returnReason,
    })),
  };
}

/** Where a book is shipment-wise: the active shipment and what else is in it (null when it is in none). */
export async function shipmentOfItem(orgId: string, itemId: string) {
  const line = await db.shipmentItem.findFirst({ where: { organizationId: orgId, inventoryItemId: itemId, isActive: true }, include: { shipment: { include: { customer: { select: { id: true, name: true } } } } } });
  if (!line) return null;
  const others = await db.shipmentItem.findMany({ where: { shipmentId: line.shipmentId, isActive: true, inventoryItemId: { not: itemId } }, include: { item: { select: { id: true, inventoryNumber: true, title: true } } } });
  return { id: line.shipmentId, number: line.shipment.number, status: line.shipment.status, customer: line.shipment.customer, others: others.map((o) => ({ itemId: o.item.id, inventoryNumber: o.item.inventoryNumber, title: o.item.title })) };
}

export interface ShipmentFilters {
  q?: string;
  houseId?: string;
  catalogId?: string;
  financial?: string;
  stage?: string;
  onlyPartial?: boolean;
  onlyReady?: boolean;
}

/**
 * The shipments screen is organised by customer: one row per customer with something waiting or open.
 * Counts keep customers, lots, physical books and shipments apart.
 */
export async function shippingOverview(user: UserPrincipal, f: ShipmentFilters = {}) {
  const purchases = await db.purchase.findMany({
    where: {
      organizationId: user.organizationId,
      status: "ACTIVE",
      ...(f.catalogId ? { catalogId: f.catalogId } : {}),
      ...(f.houseId ? { catalog: { auctionHouseId: f.houseId } } : {}),
      ...(user.houseIds === null ? {} : { catalog: { auctionHouseId: { in: user.houseIds, ...(f.houseId ? { equals: f.houseId } : {}) } } }),
    },
    select: { customerId: true },
    distinct: ["customerId"],
  });
  const customerIds = purchases.map((p) => p.customerId).filter((x): x is string => !!x);
  const customers = await db.customer.findMany({ where: { id: { in: customerIds }, ...(f.q ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { email: { contains: f.q, mode: "insensitive" } }] } : {}) }, orderBy: { name: "asc" }, take: 500 });
  const rows = [];
  const totals = { waitingBooks: 0, waitingLots: 0, customersOpen: 0, packedBooks: 0, shippedBooks: 0, completedShipments: 0, customersBlockedByPayment: 0, partialShipments: 0 };
  // warehouse staff prepare shipments but do not see money: payment states are hidden from them
  const seeMoney = canUser(user, "sales.view");
  for (const c of customers) {
    const books = await customerBooks(db, user.organizationId, c.id, { includeShipped: true });
    const waiting = books.filter((b) => b.stage !== "SHIPPED" && b.stage !== "DELIVERED");
    const shipped = books.filter((b) => b.stage === "SHIPPED" || b.stage === "DELIVERED");
    const open = await db.shipment.count({ where: { customerId: c.id, status: { in: ["DRAFT", "PACKED"] } } });
    const finStatuses = new Set(waiting.map((b) => b.financial));
    const blockedByPayment = waiting.some((b) => !b.released && b.financial !== "PAID");
    if (f.financial && !(f.financial === "PAID" ? waiting.length > 0 && !blockedByPayment : finStatuses.has(f.financial))) continue;
    if (f.stage && !waiting.some((b) => b.stage === f.stage)) continue;
    if (f.onlyReady && !waiting.some((b) => b.available)) continue;
    const partial = (await db.shipment.count({ where: { customerId: c.id, partialConfirmed: true } })) > 0;
    if (f.onlyPartial && !partial) continue;
    if (!waiting.length && !open) continue;
    const lots = (xs: WaitingBook[]) => new Set(xs.map((x) => x.purchaseId)).size;
    totals.waitingBooks += waiting.length;
    totals.waitingLots += lots(waiting);
    totals.packedBooks += waiting.filter((b) => b.stage === "PACKED").length;
    totals.shippedBooks += shipped.length;
    if (waiting.length || open) totals.customersOpen += 1;
    if (blockedByPayment) totals.customersBlockedByPayment += 1;
    if (partial) totals.partialShipments += await db.shipment.count({ where: { customerId: c.id, partialConfirmed: true } });
    rows.push({
      customerId: c.id,
      number: c.number,
      name: c.name,
      waitingLots: lots(waiting),
      waitingBooks: waiting.length,
      readyBooks: waiting.filter((b) => b.available).length,
      shippedLots: lots(shipped),
      financial: !seeMoney ? "HIDDEN" : waiting.some((b) => b.financial === "UNPAID") ? "UNPAID" : waiting.some((b) => b.financial === "PARTIAL") ? "PARTIAL" : waiting.length ? "PAID" : "NONE",
      catalogs: [...new Set(books.map((b) => (b.legacy ? "מכירה ישנה" : `${b.house} ${b.catalogNumber}`)))],
      openShipments: open,
    });
  }
  totals.completedShipments = await db.shipment.count({ where: { organizationId: user.organizationId, status: { in: ["SHIPPED", "DELIVERED"] } } });
  return { totals, rows };
}

export async function listCustomerShipments(user: UserPrincipal, customerId: string) {
  const rows = await db.shipment.findMany({ where: { organizationId: user.organizationId, customerId }, orderBy: { createdAt: "desc" }, include: { items: { where: { isActive: true }, select: { purchaseId: true } } } });
  return rows.map((s) => ({ id: s.id, number: s.number, status: s.status, method: s.method, trackingNumber: s.trackingNumber, lots: new Set(s.items.map((i) => i.purchaseId)).size, books: s.items.length, createdAt: s.createdAt.toISOString(), shippedAt: s.shippedAt?.toISOString() ?? null }));
}
