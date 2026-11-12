import "server-only";
import { z } from "zod";
import type { Purchase } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { asJson } from "../json";
import { changeStatus } from "./item-status";
import { createPickTaskTx } from "./picking";
import { syncItemCommercial } from "./assignments";

/*
 * A sale made in the old system, before AVOT. One action on the book: it becomes SOLD with a minimal purchase that
 * hangs on the book itself (no lot, no catalog, no order, no price, no buyer - unknown, never 0 and never invented).
 * Everything else (location, photos, history, an existing pick task) is left exactly as it is. A buyer can be attached
 * later with the ordinary customer screens, and then the book joins the ordinary shipment flow.
 */

async function lockItem(tx: Tx, itemId: string) {
  await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
}

/** why the action is not possible for this book, or null (also used to explain it in the menu) */
export async function legacySaleBlockReason(tx: Tx | typeof db, orgId: string, itemId: string): Promise<string | null> {
  const item = await tx.inventoryItem.findFirst({ where: { id: itemId, organizationId: orgId }, select: { commercialStatus: true, deletionRequestedAt: true } });
  if (!item) return "הספר לא נמצא";
  if (item.deletionRequestedAt) return "הספר ממתין למחיקה";
  const active = await tx.purchase.findFirst({ where: { status: "ACTIVE", OR: [{ inventoryItemId: itemId }, { lot: { members: { some: { inventoryItemId: itemId, removedAt: null } } } }] }, select: { lotId: true } });
  if (active) return active.lotId ? "הספר כבר נמכר במסגרת קטלוג ורשום ברכישה פעילה" : "הספר כבר מסומן כנמכר במערכת הישנה";
  if (item.commercialStatus === "SOLD") return "הספר כבר מסומן כנמכר";
  const lot = await tx.lotMember.findFirst({ where: { inventoryItemId: itemId, isActive: true, removedAt: null }, select: { lot: { select: { lotNumber: true, catalog: { select: { number: true } } } } } });
  if (lot) return `הספר משויך כרגע לקטלוג ${lot.lot.catalog.number} (פריט ${lot.lot.lotNumber}). מכירה שם נרשמת דרך הקטלוג, או שיש להסיר את השיוך לפני הסימון`;
  return null;
}

export async function markLegacySold(user: UserPrincipal, itemId: string) {
  return db.$transaction(async (tx) => {
    await lockItem(tx, itemId);
    const item = await tx.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId } });
    if (!item) throw notFound("הספר");
    // a double click or a second request: the first one already did it
    const same = await tx.purchase.findFirst({ where: { inventoryItemId: itemId, status: "ACTIVE", lotId: null } });
    if (same) return { purchase: same, created: false as const };
    const why = await legacySaleBlockReason(tx, user.organizationId, itemId);
    if (why) throw new AppError("CONFLICT", why, { code: "LEGACY_NOT_ALLOWED" });

    const purchase = await tx.purchase.create({
      data: { organizationId: user.organizationId, inventoryItemId: itemId, source: "LEGACY_MANUAL", createdById: user.userId },
    });
    // an existing pick task ("נמכר" written by hand) is kept untouched and only linked to this sale
    const tasks = await tx.pickTask.findMany({ where: { inventoryItemId: itemId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "asc" } });
    if (tasks.length) {
      await tx.pickTask.updateMany({ where: { id: { in: tasks.filter((t) => !t.purchaseId).map((t) => t.id) } }, data: { purchaseId: purchase.id } });
      await tx.purchase.update({ where: { id: purchase.id }, data: { releasedAt: tasks[0]!.createdAt, releaseNote: "משימת ליקוט קיימת (נמכר במערכת הישנה)" } });
    }
    await changeStatus(tx, user, itemId, "COMMERCIAL", "SOLD", { reason: "נמכר במערכת הישנה", refType: "purchase", refId: purchase.id });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId: purchase.id, kind: "LEGACY_MARKED", data: asJson({ inventoryNumber: item.inventoryNumber, hadPickTask: tasks.length > 0 }), userId: user.userId } });
    await audit(user, { action: "sale.legacy_marked", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: asJson({ purchaseId: purchase.id, hadPickTask: tasks.length > 0 }) }, tx);
    return { purchase, created: true as const };
  });
}

export const unmarkSchema = z.object({ reason: z.string().trim().min(2, "יש לציין סיבה").max(500) });

/**
 * Takes the mark back (it was made by mistake). The purchase stays as history. Not possible once the book has left;
 * then the sale needs a proper correction. Pick tasks and the shelf are never touched.
 */
export async function unmarkLegacySoldTx(tx: Tx, user: UserPrincipal, purchaseId: string, reason: string) {
  const p = await tx.purchase.findFirst({ where: { id: purchaseId, organizationId: user.organizationId } });
  if (!p || p.lotId || !p.inventoryItemId) throw notFound("המכירה הישנה");
  await lockItem(tx, p.inventoryItemId);
  const cur = await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
  if (cur.status === "CANCELLED") throw new AppError("CONFLICT", "הסימון כבר בוטל");
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: p.inventoryItemId }, select: { physicalStatus: true } });
  const gone = await tx.shipmentItem.findFirst({ where: { purchaseId, isActive: true, shipment: { status: { in: ["SHIPPED", "DELIVERED"] } } } });
  if (gone || item.physicalStatus === "SHIPPED") throw new AppError("CONFLICT", "הספר כבר נשלח. לא ניתן לבטל את הסימון בלחיצה: נדרש תהליך תיקון (החזרת הספר למחסן)");
  const now = new Date();
  await tx.shipmentItem.updateMany({ where: { purchaseId, isActive: true }, data: { isActive: false, removedAt: now, removedById: user.userId, removeReason: "סימון המכירה הישנה בוטל" } });
  // pick tasks are not deleted or changed; they simply stop belonging to this sale
  await tx.pickTask.updateMany({ where: { purchaseId }, data: { purchaseId: null } });
  await tx.purchase.update({ where: { id: purchaseId }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: user.userId, cancelReason: reason, returnedToStock: true } });
  // the commercial state is recomputed from what is still true (an assignment, or none): back to active stock only when nothing else sold it
  await syncItemCommercial(tx, user, p.inventoryItemId, { reason: "בוטל סימון מכירה ישנה" });
  await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId, customerId: cur.customerId, kind: "LEGACY_UNMARKED", data: asJson({ reason }), userId: user.userId } });
  await audit(user, { action: "sale.legacy_unmarked", entityType: "inventory", entityId: p.inventoryItemId, inventoryItemId: p.inventoryItemId, data: asJson({ purchaseId, reason }) }, tx);
  return { purchaseId };
}

export async function unmarkLegacySold(user: UserPrincipal, purchaseId: string, raw: z.input<typeof unmarkSchema>) {
  const { reason } = unmarkSchema.parse(raw);
  return db.$transaction((tx) => unmarkLegacySoldTx(tx, user, purchaseId, reason));
}

/** "שחרור לליקוט" of a legacy sale: reuses the book's open pick task, creates one only when there is none. */
export async function releaseLegacyTx(tx: Tx, user: UserPrincipal, p: Purchase, note: string | null) {
  if (!p.inventoryItemId) throw new AppError("CONFLICT", "המכירה אינה מקושרת לספר");
  await lockItem(tx, p.inventoryItemId);
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: p.inventoryItemId }, select: { physicalStatus: true } });
  if (item.physicalStatus !== "SHIPPED") await createPickTaskTx(tx, user, p.inventoryItemId, { reason: "נמכר — מכירה ישנה" });
  await tx.pickTask.updateMany({ where: { inventoryItemId: p.inventoryItemId, status: { in: ["OPEN", "PICKED", "PACKED"] }, purchaseId: null }, data: { purchaseId: p.id } });
  const u = await tx.purchase.update({ where: { id: p.id }, data: { releasedAt: new Date(), releasedById: user.userId, releaseNote: note } });
  await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId: p.id, customerId: p.customerId, kind: "RELEASED", data: asJson({ legacy: true, note }), userId: user.userId } });
  await audit(user, { action: "sale.released", entityType: "inventory", entityId: p.inventoryItemId, inventoryItemId: p.inventoryItemId, data: asJson({ purchaseId: p.id, legacy: true }) }, tx);
  return { released: true as const, purchase: u };
}

/** Attaches an existing customer to a legacy sale (later, not at marking time). Only before the books are in a shipment of someone else. */
export async function attachLegacyCustomer(user: UserPrincipal, purchaseId: string, customerId: string | null) {
  return db.$transaction(async (tx) => {
    const p = await tx.purchase.findFirst({ where: { id: purchaseId, organizationId: user.organizationId } });
    if (!p || p.lotId || !p.inventoryItemId) throw notFound("המכירה הישנה");
    if (p.status !== "ACTIVE") throw new AppError("CONFLICT", "הסימון בוטל");
    await lockItem(tx, p.inventoryItemId);
    if (customerId) {
      const c = await tx.customer.findFirst({ where: { id: customerId, organizationId: user.organizationId, status: "ACTIVE" } });
      if (!c) throw notFound("הלקוח");
    }
    if (customerId !== p.customerId && (await tx.shipmentItem.count({ where: { purchaseId, isActive: true } }))) throw new AppError("CONFLICT", "הספר כבר משויך למשלוח - לא ניתן להחליף קונה");
    const u = await tx.purchase.update({ where: { id: purchaseId }, data: { customerId } });
    await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId, customerId, kind: "LEGACY_BUYER", data: asJson({ from: p.customerId, to: customerId }), userId: user.userId } });
    await audit(user, { action: "sale.legacy_buyer", entityType: "inventory", entityId: p.inventoryItemId, inventoryItemId: p.inventoryItemId, data: asJson({ purchaseId, customerId }) }, tx);
    return u;
  });
}
