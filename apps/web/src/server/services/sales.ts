import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { canUser } from "../auth/permissions";
import { asJson } from "../json";
import { addMoney, cmpMoney, parseUsd, subMoney } from "@/lib/money";
import { endLotTx, syncItemCommercial } from "./assignments";
import { activeLotOfItem, memberItemIds } from "./lot-members";
import { createPickTaskTx } from "./picking";
import { changeStatus } from "./item-status";

/*
 * Sales core. Three states that never mix:
 *   commercial  Lot.commercialStatus + Purchase.status
 *   financial   derived here from Purchase + Payment (nothing is stored twice, so nothing can contradict)
 *   physical    InventoryItem.physicalStatus / PickTask / Shipment
 * "Sold" does not release the book to picking: releasePurchase does, explicitly.
 */

export type FinancialStatus = "NONE" | "UNPAID" | "PARTIAL" | "PAID";
export const FINANCIAL_LABEL: Record<FinancialStatus, string> = { NONE: "טרם חושב חיוב", UNPAID: "ממתין לתשלום", PARTIAL: "שולם חלקית", PAID: "שולם במלואו" };

const dec = (v: string | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));

/* ───────────────────────── ledger (financial state) ───────────────────────── */

export interface PurchaseCharge {
  id: string;
  /** hammer + known commission + known tax; unknown parts are not counted */
  charge: string;
  /** commission or tax unknown: the charge is a lower bound */
  incomplete: boolean;
  /** payments allocated to this purchase (oldest purchase first) */
  paid: string;
  status: FinancialStatus;
}

export interface OrderLedger {
  orderId: string;
  purchases: PurchaseCharge[];
  charge: string;
  paid: string;
  /** what is still due (never negative) */
  due: string;
  overpaid: string | null;
  incomplete: boolean;
  status: FinancialStatus;
}

type LedgerPurchase = { id: string; status: string; hammerPrice: Prisma.Decimal; buyerPremium: Prisma.Decimal | null; tax: Prisma.Decimal | null; createdAt: Date; lot?: { lotNumber: number } };

/** Pure: money states from the active purchases and the recorded payments of one order. Payments settle purchases in lot order. */
export function computeLedger(orderId: string, purchases: LedgerPurchase[], payments: { amount: Prisma.Decimal; status: string }[]): OrderLedger {
  const active = purchases.filter((p) => p.status === "ACTIVE").sort((a, b) => (a.lot?.lotNumber ?? 0) - (b.lot?.lotNumber ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
  const totalPaid = addMoney(...payments.filter((p) => p.status === "RECORDED").map((p) => p.amount.toFixed(2)));
  let left = totalPaid;
  const rows: PurchaseCharge[] = active.map((p) => {
    const charge = addMoney(p.hammerPrice.toFixed(2), p.buyerPremium?.toFixed(2), p.tax?.toFixed(2));
    const put = cmpMoney(left, charge) >= 0 ? charge : cmpMoney(left, "0.00") > 0 ? left : "0.00";
    left = subMoney(left, put);
    return {
      id: p.id,
      charge,
      incomplete: p.buyerPremium === null || p.tax === null,
      paid: put,
      status: cmpMoney(put, "0.00") === 0 ? "UNPAID" : cmpMoney(put, charge) >= 0 ? "PAID" : "PARTIAL",
    };
  });
  const charge = addMoney(...rows.map((r) => r.charge));
  const status: FinancialStatus = !rows.length ? "NONE" : cmpMoney(totalPaid, "0.00") === 0 ? "UNPAID" : cmpMoney(totalPaid, charge) >= 0 ? "PAID" : "PARTIAL";
  const due = cmpMoney(charge, totalPaid) > 0 ? subMoney(charge, totalPaid) : "0.00";
  return { orderId, purchases: rows, charge, paid: totalPaid, due, overpaid: cmpMoney(totalPaid, charge) > 0 && rows.length ? subMoney(totalPaid, charge) : null, incomplete: rows.some((r) => r.incomplete), status };
}

export async function orderLedger(tx: Tx | typeof db, orderId: string): Promise<OrderLedger> {
  const [purchases, payments] = await Promise.all([
    tx.purchase.findMany({ where: { orderId }, select: { id: true, status: true, hammerPrice: true, buyerPremium: true, tax: true, createdAt: true, lot: { select: { lotNumber: true } } } }),
    tx.payment.findMany({ where: { orderId }, select: { amount: true, status: true } }),
  ]);
  return computeLedger(orderId, purchases, payments);
}

/* ───────────────────────── recording a sale ───────────────────────── */

async function lockLotAndItems(tx: Tx, lotId: string) {
  await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lotId}::uuid FOR UPDATE`;
  const ids = (await memberItemIds(lotId, tx)).sort();
  if (ids.length) await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  return ids;
}

export interface SaleInput {
  lotId: string;
  customerId: string;
  hammerPrice: string;
  buyerPremium?: string | null;
  tax?: string | null;
  source: "IMPORT" | "MANUAL" | "POST_SALE";
  bidderNumber?: string | null;
  externalTransactionId?: string | null;
  orderExternalId?: string | null;
  importId?: string | null;
}

/**
 * Makes the lot SOLD to the customer: one purchase for the whole lot (a combined lot is one sale of several books),
 * in the customer's order for that sale. Works for a lot still in the sale, for a lot that did not sell at the auction
 * (a later deal: afterAuction is recorded, the "not sold at the auction" fact stays), and for a legacy lot already marked
 * sold with no buyer (the buyer is attached). Throws CONFLICT when the lot already has an active purchase.
 */
export async function recordSaleTx(tx: Tx, principal: Principal, input: SaleInput) {
  const itemIds = await lockLotAndItems(tx, input.lotId);
  const lot = await tx.lot.findUniqueOrThrow({ where: { id: input.lotId }, include: { catalog: true } });
  if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר - המכירה נרשמת בלוט המשולב");
  const existing = await tx.purchase.findFirst({ where: { lotId: lot.id, status: "ACTIVE" } });
  if (existing) throw new AppError("CONFLICT", `לפריט ${lot.lotNumber} כבר קיימת רכישה פעילה`, { code: "PURCHASE_EXISTS", purchaseId: existing.id });

  const wasUnsold = lot.commercialStatus === "UNSOLD";
  const legacySold = lot.commercialStatus === "SOLD";
  if (lot.commercialStatus === "WITHDRAWN" && lot.assignmentStatus === "ENDED") throw new AppError("CONFLICT", `פריט ${lot.lotNumber} הוסר מהקטלוג ואינו ניתן למכירה`);
  if (lot.assignmentStatus === "ENDED" && !legacySold) {
    // an unsold lot released to stock: a late deal is possible while the book was not assigned elsewhere
    for (const itemId of itemIds) {
      const other = await activeLotOfItem(itemId, tx);
      if (other && other.id !== lot.id) throw new AppError("CONFLICT", "הספר שויך מאז לקטלוג אחר - לא ניתן לרשום מכירה בשיוך הישן");
    }
  }
  if (!legacySold) await endLotTx(tx, principal, lot.id, "SOLD", input.source === "POST_SALE" ? "נמכר לאחר המכרז" : null);

  const customer = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: principal.organizationId, status: "ACTIVE" } });
  if (!customer) throw notFound("הלקוח");
  const order = await tx.buyerOrder.upsert({
    where: { catalogId_customerId: { catalogId: lot.catalogId, customerId: customer.id } },
    create: { organizationId: principal.organizationId, catalogId: lot.catalogId, customerId: customer.id, externalOrderId: input.orderExternalId ?? null },
    update: input.orderExternalId ? { externalOrderId: input.orderExternalId } : {},
  });
  const afterAuction = input.source === "POST_SALE" || (wasUnsold && input.source !== "IMPORT");
  const purchase = await tx.purchase.create({
    data: {
      organizationId: principal.organizationId,
      orderId: order.id,
      customerId: customer.id,
      catalogId: lot.catalogId,
      lotId: lot.id,
      source: input.source,
      afterAuction,
      hammerPrice: new Prisma.Decimal(input.hammerPrice),
      buyerPremium: dec(input.buyerPremium),
      tax: dec(input.tax),
      startingPriceAtSale: lot.startingPrice,
      bidderNumber: input.bidderNumber ?? null,
      externalTransactionId: input.externalTransactionId ?? null,
      importId: input.importId ?? null,
      createdById: principal.kind === "user" ? principal.userId : null,
    },
  });
  // a legacy lot that was sold before buyers were recorded may already have pick tasks: they belong to this purchase
  const tasks = await tx.pickTask.findMany({ where: { lotId: lot.id, status: { not: "CANCELLED" } } });
  if (tasks.length) {
    await tx.pickTask.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { purchaseId: purchase.id } });
    await tx.purchase.update({ where: { id: purchase.id }, data: { releasedAt: tasks.map((t) => t.createdAt).sort((a, b) => a.getTime() - b.getTime())[0], releasedUnpaid: true, releaseNote: "שוחרר לפני שנרשם קונה (נתון ישן)" } });
  }
  for (const itemId of itemIds) await syncItemCommercial(tx, principal, itemId, { reason: "נמכר", refId: lot.id });
  await tx.saleEvent.create({
    data: {
      organizationId: principal.organizationId,
      purchaseId: purchase.id,
      customerId: customer.id,
      catalogId: lot.catalogId,
      kind: afterAuction ? "SOLD_AFTER_AUCTION" : "SOLD",
      data: asJson({ lotNumber: lot.lotNumber, hammerPrice: input.hammerPrice, source: input.source, importId: input.importId ?? null }),
      userId: principal.kind === "user" ? principal.userId : null,
    },
  });
  await audit(principal, { action: "sale.recorded", entityType: "lot", entityId: lot.id, lotId: lot.id, inventoryItemId: lot.inventoryItemId, data: asJson({ purchaseId: purchase.id, customerId: customer.id, hammerPrice: input.hammerPrice, afterAuction }) }, tx);
  return purchase;
}

const moneyField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseUsd(v, { allowZero: true });
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

export const recordSaleSchema = z.object({
  lotId: z.string().uuid(),
  customerId: z.string().uuid(),
  hammerPrice: moneyField.refine((v) => v !== null, "מחיר הפטיש נדרש"),
  buyerPremium: moneyField.nullish(),
  tax: moneyField.nullish(),
  /** the lot did not sell at the auction: a deal made afterwards */
  afterAuction: z.boolean().optional(),
});

/** A person records a sale by hand (also the late deal after the auction, and attaching a buyer to a legacy sold lot). */
export async function recordSale(user: UserPrincipal, raw: z.input<typeof recordSaleSchema>) {
  const input = recordSaleSchema.parse(raw);
  const lot = await db.lot.findFirst({ where: { id: input.lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  return db.$transaction((tx) =>
    recordSaleTx(tx, user, {
      lotId: lot.id,
      customerId: input.customerId,
      hammerPrice: input.hammerPrice!,
      buyerPremium: input.buyerPremium ?? null,
      tax: input.tax ?? null,
      source: input.afterAuction || lot.commercialStatus === "UNSOLD" ? "POST_SALE" : "MANUAL",
    }),
  );
}

/* ───────────────────────── corrections & cancellation ───────────────────────── */

export const correctPurchaseSchema = z.object({
  customerId: z.string().uuid().optional(),
  hammerPrice: moneyField.refine((v) => v !== null, "מחיר הפטיש נדרש").optional(),
  buyerPremium: moneyField.nullish(),
  tax: moneyField.nullish(),
  note: z.string().trim().max(500).nullish(),
});

async function loadPurchase(user: UserPrincipal, id: string) {
  const p = await db.purchase.findFirst({ where: { id, organizationId: user.organizationId }, include: { catalog: true, lot: true } });
  if (!p) throw notFound("הרכישה");
  assertHouse(user, p.catalog.auctionHouseId);
  return p;
}

/** Manual correction of a recorded sale. The corrected fields are remembered: a later import never overwrites them. */
export async function correctPurchase(user: UserPrincipal, id: string, raw: z.input<typeof correctPurchaseSchema>) {
  const input = correctPurchaseSchema.parse(raw);
  const p = await loadPurchase(user, id);
  if (p.status !== "ACTIVE") throw new AppError("CONFLICT", "הרכישה בוטלה ואינה ניתנת לתיקון");
  return db.$transaction(async (tx) => {
    const cur = await tx.purchase.findUniqueOrThrow({ where: { id } });
    const data: Prisma.PurchaseUncheckedUpdateInput = {};
    const touched = new Set<string>(cur.manualFields as string[]);
    const before: Record<string, unknown> = {};
    if (input.hammerPrice !== undefined && input.hammerPrice !== cur.hammerPrice.toFixed(2)) {
      before.hammerPrice = cur.hammerPrice.toFixed(2);
      data.hammerPrice = new Prisma.Decimal(input.hammerPrice!);
      touched.add("hammerPrice");
    }
    if (input.buyerPremium !== undefined && input.buyerPremium !== (cur.buyerPremium?.toFixed(2) ?? null)) {
      before.buyerPremium = cur.buyerPremium?.toFixed(2) ?? null;
      data.buyerPremium = dec(input.buyerPremium);
      touched.add("buyerPremium");
    }
    if (input.tax !== undefined && input.tax !== (cur.tax?.toFixed(2) ?? null)) {
      before.tax = cur.tax?.toFixed(2) ?? null;
      data.tax = dec(input.tax);
      touched.add("tax");
    }
    if (input.customerId && input.customerId !== cur.customerId) {
      const c = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: user.organizationId, status: "ACTIVE" } });
      if (!c) throw notFound("הלקוח");
      const shipped = await tx.shipmentItem.count({ where: { purchaseId: id, isActive: true } });
      if (shipped) throw new AppError("CONFLICT", "הרכישה כבר משויכת למשלוח - לא ניתן להחליף קונה");
      const paid = await tx.payment.count({ where: { orderId: cur.orderId, status: "RECORDED" } });
      if (paid) throw new AppError("CONFLICT", "נרשמו תשלומים להזמנה של הקונה הנוכחי - לא ניתן להחליף קונה לפני ביטול התשלומים");
      const order = await tx.buyerOrder.upsert({
        where: { catalogId_customerId: { catalogId: cur.catalogId, customerId: c.id } },
        create: { organizationId: user.organizationId, catalogId: cur.catalogId, customerId: c.id },
        update: {},
      });
      before.customerId = cur.customerId;
      data.customerId = c.id;
      data.orderId = order.id;
      touched.add("customer");
    }
    if (!Object.keys(data).length) return cur;
    data.manualFields = [...touched];
    const u = await tx.purchase.update({ where: { id }, data });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId: id, customerId: u.customerId, catalogId: u.catalogId, kind: "CORRECTED", data: asJson({ before, note: input.note ?? null }), userId: user.userId } });
    await audit(user, { action: "sale.corrected", entityType: "lot", entityId: u.lotId, lotId: u.lotId, data: asJson({ purchaseId: id, before }) }, tx);
    return u;
  });
}

export const cancelPurchaseSchema = z.object({
  reason: z.string().trim().min(2, "יש לציין סיבת ביטול").max(500),
  refundNote: z.string().trim().max(500).nullish(),
});

/**
 * Cancels the deal; the purchase stays with its buyer, price, time, reason and who cancelled. Only books that are back
 * in the warehouse (not shipped / delivered) can be cancelled: a shipped book is returned first. Open pick tasks and
 * unsent shipment lines are closed; the lot becomes "not sold" and the book can be assigned again.
 */
export async function cancelPurchase(user: UserPrincipal, id: string, raw: z.input<typeof cancelPurchaseSchema>) {
  const input = cancelPurchaseSchema.parse(raw);
  const p = await loadPurchase(user, id);
  return db.$transaction(async (tx) => {
    const itemIds = await lockLotAndItems(tx, p.lotId);
    const cur = await tx.purchase.findUniqueOrThrow({ where: { id } });
    if (cur.status === "CANCELLED") throw new AppError("CONFLICT", "הרכישה כבר בוטלה");
    const gone = await tx.shipmentItem.findFirst({ where: { purchaseId: id, isActive: true, shipment: { status: { in: ["SHIPPED", "DELIVERED"] } } } });
    const items = await tx.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { inventoryNumber: true, physicalStatus: true } });
    if (gone || items.some((i) => i.physicalStatus === "SHIPPED")) throw new AppError("CONFLICT", "הספר כבר נשלח. יש לרשום את החזרתו למחסן לפני ביטול העסקה");
    const now = new Date();
    // unsent shipment lines
    await tx.shipmentItem.updateMany({ where: { purchaseId: id, isActive: true }, data: { isActive: false, removedAt: now, removedById: user.userId, removeReason: "העסקה בוטלה" } });
    // open pick tasks: the book stays on its shelf (or must be re-shelved by the warehouse if already picked)
    for (const t of await tx.pickTask.findMany({ where: { lotId: p.lotId, status: { in: ["OPEN", "PICKED", "PACKED"] } } })) {
      await tx.pickTask.update({ where: { id: t.id }, data: { status: "CANCELLED", cancelledAt: now } });
      const it = await tx.inventoryItem.findUniqueOrThrow({ where: { id: t.inventoryItemId }, select: { currentLocationId: true } });
      await changeStatus(tx, user, t.inventoryItemId, "PHYSICAL", it.currentLocationId ? "IN_STORAGE" : "AWAITING_STORAGE", { refType: "pick", refId: t.id, reason: "העסקה בוטלה" });
    }
    await tx.purchase.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: now, cancelledById: user.userId, cancelReason: input.reason, refundNote: input.refundNote ?? null, returnedToStock: true },
    });
    // the lot is not sold any more; its sale history stays on the purchase
    await tx.lot.update({ where: { id: p.lotId }, data: { commercialStatus: "UNSOLD" } });
    for (const itemId of itemIds) await syncItemCommercial(tx, user, itemId, { reason: "עסקה בוטלה", refId: p.lotId });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId: id, customerId: p.customerId, catalogId: p.catalogId, kind: "CANCELLED", data: asJson({ reason: input.reason, hammerPrice: p.hammerPrice.toFixed(2), refundNote: input.refundNote ?? null }), userId: user.userId } });
    await audit(user, { action: "sale.cancelled", entityType: "lot", entityId: p.lotId, lotId: p.lotId, data: asJson({ purchaseId: id, reason: input.reason }) }, tx);
    return { purchaseId: id };
  });
}

/* ───────────────────────── payments ───────────────────────── */

export const paymentSchema = z.object({
  amount: moneyField.refine((v) => v !== null, "סכום התשלום נדרש"),
  paidAt: z.coerce.date().optional(),
  method: z.string().trim().max(60).nullish(),
  reference: z.string().trim().max(120).nullish(),
});

export async function recordPayment(user: UserPrincipal, orderId: string, raw: z.input<typeof paymentSchema>) {
  const input = paymentSchema.parse(raw);
  const order = await db.buyerOrder.findFirst({ where: { id: orderId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!order) throw notFound("ההזמנה");
  assertHouse(user, order.catalog.auctionHouseId);
  if (!input.amount || cmpMoney(input.amount, "0.00") <= 0) throw new AppError("VALIDATION", "סכום התשלום חייב להיות גדול מאפס");
  return db.$transaction(async (tx) => {
    const pay = await tx.payment.create({
      data: { organizationId: user.organizationId, orderId, amount: new Prisma.Decimal(input.amount!), paidAt: input.paidAt ?? new Date(), method: input.method ?? null, reference: input.reference ?? null, recordedById: user.userId },
    });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: order.customerId, catalogId: order.catalogId, kind: "PAYMENT", data: asJson({ paymentId: pay.id, amount: input.amount, method: input.method ?? null }), userId: user.userId } });
    await audit(user, { action: "payment.recorded", entityType: "settings", entityId: pay.id, data: asJson({ orderId, amount: input.amount }) }, tx);
    return { payment: pay, ledger: await orderLedger(tx, orderId) };
  });
}

export async function voidPayment(user: UserPrincipal, paymentId: string, reason: string) {
  if (!reason?.trim()) throw new AppError("VALIDATION", "יש לציין סיבת ביטול");
  const pay = await db.payment.findFirst({ where: { id: paymentId, organizationId: user.organizationId }, include: { order: { include: { catalog: true } } } });
  if (!pay) throw notFound("התשלום");
  assertHouse(user, pay.order.catalog.auctionHouseId);
  return db.$transaction(async (tx) => {
    const r = await tx.payment.updateMany({ where: { id: paymentId, status: "RECORDED" }, data: { status: "VOIDED", voidedAt: new Date(), voidedById: user.userId, voidReason: reason.trim() } });
    if (!r.count) throw new AppError("CONFLICT", "התשלום כבר בוטל");
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: pay.order.customerId, catalogId: pay.order.catalogId, kind: "PAYMENT_VOIDED", data: asJson({ paymentId, amount: pay.amount.toFixed(2), reason: reason.trim() }), userId: user.userId } });
    return { ledger: await orderLedger(tx, pay.orderId) };
  });
}

/* ───────────────────────── release to picking ───────────────────────── */

/**
 * "שחרור לליקוט": only now do pick tasks appear (one per physical book of the lot). A purchase that is not fully paid
 * needs the separate permission pick.release.unpaid; the exception is recorded.
 */
export async function releasePurchaseTx(tx: Tx, user: UserPrincipal, purchaseId: string, opts: { note?: string | null } = {}) {
  const p = await tx.purchase.findFirst({ where: { id: purchaseId, organizationId: user.organizationId }, include: { lot: { include: { catalog: true } } } });
  if (!p) throw notFound("הרכישה");
  assertHouse(user, p.lot.catalog.auctionHouseId);
  if (p.status !== "ACTIVE") throw new AppError("CONFLICT", "העסקה בוטלה - לא ניתן לשחרר לליקוט");
  if (p.releasedAt) return { released: false as const, purchase: p };
  const ledger = await orderLedger(tx, p.orderId);
  const mine = ledger.purchases.find((x) => x.id === purchaseId);
  const paid = mine?.status === "PAID";
  if (!paid && !canUser(user, "pick.release.unpaid")) {
    throw new AppError("FORBIDDEN", "הרכישה טרם שולמה במלואה. שחרור לליקוט לפני תשלום דורש הרשאה מיוחדת.", { code: "UNPAID_RELEASE" });
  }
  const itemIds = await lockLotAndItems(tx, p.lotId);
  for (const itemId of itemIds) await createPickTaskTx(tx, user, itemId, { lotId: p.lotId, reason: `נמכר — קטלוג ${p.lot.catalog.number}, פריט ${p.lot.lotNumber}` });
  await tx.pickTask.updateMany({ where: { lotId: p.lotId, status: { in: ["OPEN", "PICKED", "PACKED"] } }, data: { purchaseId } });
  const u = await tx.purchase.update({ where: { id: purchaseId }, data: { releasedAt: new Date(), releasedById: user.userId, releasedUnpaid: !paid, releaseNote: opts.note ?? null } });
  await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId, customerId: p.customerId, catalogId: p.catalogId, kind: paid ? "RELEASED" : "RELEASED_UNPAID", data: asJson({ books: itemIds.length, note: opts.note ?? null }), userId: user.userId } });
  await audit(user, { action: "sale.released", entityType: "lot", entityId: p.lotId, lotId: p.lotId, data: asJson({ purchaseId, unpaid: !paid }) }, tx);
  return { released: true as const, purchase: u };
}

export async function releasePurchase(user: UserPrincipal, purchaseId: string, opts: { note?: string | null } = {}) {
  return db.$transaction((tx) => releasePurchaseTx(tx, user, purchaseId, opts));
}

/** Releases every ACTIVE, unreleased and fully paid purchase of an order in one go. */
export async function releasePaidOfOrder(user: UserPrincipal, orderId: string) {
  const order = await db.buyerOrder.findFirst({ where: { id: orderId, organizationId: user.organizationId } });
  if (!order) throw notFound("ההזמנה");
  return db.$transaction(async (tx) => {
    const ledger = await orderLedger(tx, orderId);
    const ready = ledger.purchases.filter((x) => x.status === "PAID");
    let released = 0;
    for (const r of ready) if ((await releasePurchaseTx(tx, user, r.id)).released) released += 1;
    return { released };
  });
}

/* ───────────────────────── physical stage (read model) ───────────────────────── */

export type Stage = "IN_WAREHOUSE" | "AWAITING_PICK" | "PICKED" | "PACKED" | "SHIPPED" | "DELIVERED";
export const STAGE_LABEL: Record<Stage, string> = { IN_WAREHOUSE: "במחסן", AWAITING_PICK: "ממתין לליקוט", PICKED: "לוקט", PACKED: "נארז", SHIPPED: "נשלח", DELIVERED: "נמסר" };
const STAGE_ORDER: Stage[] = ["IN_WAREHOUSE", "AWAITING_PICK", "PICKED", "PACKED", "SHIPPED", "DELIVERED"];

/** the stage of a purchase = the least advanced of its books (a combined lot is not "shipped" because one book is) */
export function stageOf(items: { physicalStatus: string; delivered?: boolean }[]): Stage {
  const one = (i: { physicalStatus: string; delivered?: boolean }): Stage =>
    i.physicalStatus === "SHIPPED" ? (i.delivered ? "DELIVERED" : "SHIPPED") : i.physicalStatus === "PACKED" ? "PACKED" : i.physicalStatus === "PICKED" ? "PICKED" : i.physicalStatus === "AWAITING_PICK" ? "AWAITING_PICK" : "IN_WAREHOUSE";
  if (!items.length) return "IN_WAREHOUSE";
  return items.map(one).sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))[0]!;
}

