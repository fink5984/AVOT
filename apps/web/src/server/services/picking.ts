import "server-only";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { changeStatus } from "./item-status";
import { locationInclude, locationLabel } from "./location-label";
import { moveItemTx } from "./warehouse";

/*
 * Pick → pack → ship are three separate steps. A pick task is created when a
 * book is sold (or manually); scanning the right book on the handheld marks it
 * picked and takes it off its shelf. Packing and shipping are recorded
 * separately (desktop or handheld). At most one open task per book (partial
 * unique index).
 */

const OPEN = ["OPEN", "PICKED", "PACKED"] as const;

export async function createPickTaskTx(tx: Tx, principal: Principal, itemId: string, opts: { lotId?: string | null; reason: string; note?: string | null }) {
  const existing = await tx.pickTask.findFirst({ where: { inventoryItemId: itemId, status: { in: [...OPEN] } } });
  if (existing) return existing;
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  if (item.physicalStatus === "SHIPPED") throw new AppError("CONFLICT", "הספר כבר נשלח");
  const task = await tx.pickTask.create({
    data: {
      organizationId: item.organizationId,
      inventoryItemId: itemId,
      lotId: opts.lotId ?? null,
      reason: opts.reason,
      note: opts.note ?? null,
      sourceLocationId: item.currentLocationId,
      createdById: principal.kind === "user" ? principal.userId : null,
    },
  });
  await changeStatus(tx, principal, itemId, "PHYSICAL", "AWAITING_PICK", { refType: "pick", refId: task.id, reason: opts.reason });
  await audit(principal, { action: "pick.created", entityType: "pick", entityId: task.id, inventoryItemId: itemId, lotId: opts.lotId ?? null, data: { reason: opts.reason } }, tx);
  return task;
}

export async function createPickTask(user: UserPrincipal, itemId: string, reason: string, note?: string | null) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId } });
  if (!item) throw notFound("הספר");
  return db.$transaction((tx) => createPickTaskTx(tx, user, itemId, { reason, note }));
}

/** Open tasks in walking order (zone / shelf / cell) — a pick route through the warehouse. */
export async function listPickTasks(orgId: string, opts: { status?: "open" | "all" | (typeof OPEN)[number]; zoneId?: string } = {}) {
  const statusWhere =
    opts.status === "all" ? {} : opts.status && opts.status !== "open" ? { status: opts.status } : { status: { in: [...OPEN] as ("OPEN" | "PICKED" | "PACKED")[] } };
  const tasks = await db.pickTask.findMany({
    where: { organizationId: orgId, ...statusWhere, ...(opts.zoneId ? { item: { currentLocation: { shelf: { zoneId: opts.zoneId } } } } : {}) },
    include: {
      item: { select: { id: true, inventoryNumber: true, title: true, primaryAssetId: true, physicalStatus: true, currentLocation: { include: locationInclude } } },
      lot: { select: { lotNumber: true, catalog: { select: { number: true, auctionHouse: { select: { name: true } } } } } },
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  return tasks
    .map((t) => ({
      id: t.id,
      status: t.status,
      reason: t.reason,
      createdAt: t.createdAt.toISOString(),
      pickedAt: t.pickedAt?.toISOString() ?? null,
      packedAt: t.packedAt?.toISOString() ?? null,
      shippedAt: t.shippedAt?.toISOString() ?? null,
      item: { id: t.item.id, inventoryNumber: t.item.inventoryNumber, title: t.item.title, thumbAssetId: t.item.primaryAssetId, physicalStatus: t.item.physicalStatus },
      location: t.item.currentLocation ? { code: t.item.currentLocation.code, label: locationLabel(t.item.currentLocation), sortKey: t.item.currentLocation.sortKey } : null,
      lot: t.lot ? { lotNumber: t.lot.lotNumber, catalogNumber: t.lot.catalog.number, house: t.lot.catalog.auctionHouse.name } : null,
    }))
    .sort((a, b) => (a.location?.sortKey ?? "~").localeCompare(b.location?.sortKey ?? "~"));
}

/** Handheld: the scanned book is the one to pick → mark picked and take it off the shelf. */
export async function pickItemTx(tx: Tx, principal: Principal, itemId: string, opts: { opId?: string | null; occurredAt?: Date } = {}) {
  const task = await tx.pickTask.findFirst({ where: { inventoryItemId: itemId, status: { in: [...OPEN] } } });
  if (!task) return { kind: "none" as const };
  if (task.status !== "OPEN") return { kind: "already" as const, task };
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { currentLocationId: true } });
  if (item.currentLocationId) await moveItemTx(tx, principal, itemId, null, "PICK", opts);
  const updated = await tx.pickTask.update({
    where: { id: task.id },
    data: { status: "PICKED", pickedAt: opts.occurredAt ?? new Date(), pickedById: principal.kind === "user" ? principal.userId : null },
  });
  await changeStatus(tx, principal, itemId, "PHYSICAL", "PICKED", { refType: "pick", refId: task.id });
  return { kind: "picked" as const, task: updated };
}

export async function countOpenPicks(orgId: string, tx: Tx = db) {
  return tx.pickTask.count({ where: { organizationId: orgId, status: "OPEN" } });
}

async function loadTask(user: UserPrincipal, id: string) {
  const task = await db.pickTask.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!task) throw notFound("משימת הליקוט");
  return task;
}

export async function markPacked(user: UserPrincipal, id: string) {
  const task = await loadTask(user, id);
  if (task.status !== "PICKED") throw new AppError("CONFLICT", task.status === "OPEN" ? "יש ללקט את הספר לפני האריזה" : "המשימה אינה ממתינה לאריזה");
  await db.$transaction(async (tx) => {
    await tx.pickTask.update({ where: { id }, data: { status: "PACKED", packedAt: new Date(), packedById: user.userId } });
    await changeStatus(tx, user, task.inventoryItemId, "PHYSICAL", "PACKED", { refType: "pick", refId: id });
    await audit(user, { action: "pick.packed", entityType: "pick", entityId: id, inventoryItemId: task.inventoryItemId }, tx);
  });
}

export async function markShipped(user: UserPrincipal, id: string) {
  const task = await loadTask(user, id);
  if (task.status !== "PACKED") throw new AppError("CONFLICT", "יש לארוז את הספר לפני המשלוח");
  await db.$transaction(async (tx) => {
    await tx.pickTask.update({ where: { id }, data: { status: "SHIPPED", shippedAt: new Date(), shippedById: user.userId } });
    await changeStatus(tx, user, task.inventoryItemId, "PHYSICAL", "SHIPPED", { refType: "pick", refId: id });
    await audit(user, { action: "pick.shipped", entityType: "pick", entityId: id, inventoryItemId: task.inventoryItemId }, tx);
  });
}

/** Cancel: a book still on its shelf goes back to "in storage"; a picked one must be re-shelved. */
export async function cancelPickTask(user: UserPrincipal, id: string) {
  const task = await loadTask(user, id);
  if (task.status === "SHIPPED" || task.status === "CANCELLED") throw new AppError("CONFLICT", "המשימה כבר הסתיימה");
  await db.$transaction(async (tx) => {
    await tx.pickTask.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: task.inventoryItemId }, select: { currentLocationId: true } });
    await changeStatus(tx, user, task.inventoryItemId, "PHYSICAL", item.currentLocationId ? "IN_STORAGE" : "AWAITING_STORAGE", { refType: "pick", refId: id, reason: "משימת ליקוט בוטלה" });
    await audit(user, { action: "pick.cancelled", entityType: "pick", entityId: id, inventoryItemId: task.inventoryItemId }, tx);
  });
}
