import "server-only";
import { z } from "zod";
import { BOOK_SIZES, formatLocationCode } from "@avot/shared";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { changeStatus, storeBlockedReason } from "./item-status";
import { locationInclude, locationLabel } from "./location-label";

const code = (label: string, max = 12) =>
  z
    .string()
    .trim()
    .min(1, `${label} נדרש`)
    .max(max)
    .regex(/^[A-Za-z0-9]+$/, `${label}: אותיות לטיניות וספרות בלבד (מודפס בברקוד)`)
    .transform((v) => v.toUpperCase());

export async function defaultWarehouse(orgId: string, tx: Tx = db) {
  const w = await tx.warehouse.findFirst({ where: { organizationId: orgId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!w) throw new AppError("CONFLICT", "לא הוגדר מחסן");
  return w;
}

export const warehouseSchema = z.object({ code: code("קוד מחסן", 8), name: z.string().trim().min(1).max(100), notes: z.string().trim().max(1000).nullish() });

export async function createWarehouse(user: UserPrincipal, input: z.infer<typeof warehouseSchema>) {
  const clash = await db.warehouse.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: input.code } } });
  if (clash) throw new AppError("CONFLICT", `מחסן ${input.code} כבר קיים`);
  // the first warehouse in the organization becomes the default (its code is omitted from location barcodes)
  const first = (await db.warehouse.count({ where: { organizationId: user.organizationId } })) === 0;
  const w = await db.warehouse.create({ data: { organizationId: user.organizationId, code: input.code, name: input.name, notes: input.notes ?? null, isDefault: first } });
  await audit(user, { action: "warehouse.created", entityType: "warehouse", entityId: w.id, data: { code: w.code, name: w.name } });
  return w;
}

export const zoneSchema = z.object({ warehouseId: z.string().uuid().optional(), code: code("קוד אזור", 4), name: z.string().trim().max(100).optional() });

export async function createZone(user: UserPrincipal, input: z.infer<typeof zoneSchema>) {
  const w = input.warehouseId
    ? await db.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: user.organizationId } })
    : await defaultWarehouse(user.organizationId);
  if (!w) throw notFound("המחסן");
  const clash = await db.warehouseZone.findUnique({ where: { warehouseId_code: { warehouseId: w.id, code: input.code } } });
  if (clash) throw new AppError("CONFLICT", `אזור ${input.code} כבר קיים`);
  const count = await db.warehouseZone.count({ where: { warehouseId: w.id } });
  const z = await db.warehouseZone.create({ data: { warehouseId: w.id, code: input.code, name: input.name || `אזור ${input.code}`, sortOrder: count + 1 } });
  await audit(user, { action: "warehouse.zone_created", entityType: "warehouse", entityId: z.id, data: { code: z.code } });
  return z;
}

export const shelfSchema = z.object({
  zoneId: z.string().uuid(),
  code: code("קוד מדף", 4),
  shelfType: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

async function zoneOf(orgId: string, zoneId: string) {
  const zone = await db.warehouseZone.findFirst({ where: { id: zoneId, warehouse: { organizationId: orgId } }, include: { warehouse: true } });
  if (!zone) throw notFound("האזור");
  return zone;
}

export async function createShelf(user: UserPrincipal, input: z.infer<typeof shelfSchema>) {
  await zoneOf(user.organizationId, input.zoneId);
  const clash = await db.shelf.findUnique({ where: { zoneId_code: { zoneId: input.zoneId, code: input.code } } });
  if (clash) throw new AppError("CONFLICT", `מדף ${input.code} כבר קיים באזור`);
  const count = await db.shelf.count({ where: { zoneId: input.zoneId } });
  const s = await db.shelf.create({ data: { zoneId: input.zoneId, code: input.code, shelfType: input.shelfType ?? null, notes: input.notes ?? null, sortOrder: count + 1 } });
  await audit(user, { action: "warehouse.shelf_created", entityType: "warehouse", entityId: s.id, data: { code: s.code } });
  return s;
}

export const locationsSchema = z.object({
  shelfId: z.string().uuid(),
  /** cell codes to create, e.g. ["01","02"]; or a numeric range */
  cells: z.array(code("קוד תא", 4)).max(200).optional(),
  from: z.number().int().min(0).max(999).optional(),
  to: z.number().int().min(0).max(999).optional(),
  sizeClass: z.enum(BOOK_SIZES).nullish(),
  capacity: z.number().int().min(1).max(10000).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

/** sortable key: zone/shelf/cell, numeric parts zero-padded so "A-10" sorts after "A-9" */
function sortKey(...parts: string[]) {
  return parts.map((p) => p.replace(/\d+/g, (d) => d.padStart(4, "0"))).join("/");
}

export async function createLocations(user: UserPrincipal, input: z.infer<typeof locationsSchema>) {
  const shelf = await db.shelf.findFirst({ where: { id: input.shelfId, zone: { warehouse: { organizationId: user.organizationId } } }, include: { zone: { include: { warehouse: true } } } });
  if (!shelf) throw notFound("המדף");
  let cells = input.cells ?? [];
  if (!cells.length && input.from !== undefined && input.to !== undefined) {
    if (input.to < input.from || input.to - input.from > 199) throw new AppError("VALIDATION", "טווח תאים לא תקין (עד 200)");
    cells = Array.from({ length: input.to - input.from + 1 }, (_, i) => String(input.from! + i).padStart(2, "0"));
  }
  if (!cells.length) throw new AppError("VALIDATION", "יש לציין תאים");
  const wh = shelf.zone.warehouse;
  const rows = cells.map((cell) => ({
    organizationId: user.organizationId,
    shelfId: shelf.id,
    cell,
    code: formatLocationCode({ warehouse: wh.isDefault ? null : wh.code, zone: shelf.zone.code, shelf: shelf.code, cell }),
    sizeClass: input.sizeClass ?? null,
    capacity: input.capacity ?? null,
    notes: input.notes ?? null,
    sortKey: sortKey(wh.code, shelf.zone.code, shelf.code, cell),
  }));
  const existing = await db.storageLocation.findMany({ where: { organizationId: user.organizationId, code: { in: rows.map((r) => r.code) } }, select: { code: true } });
  if (existing.length) throw new AppError("CONFLICT", `מיקומים כבר קיימים: ${existing.map((e) => e.code).join(", ")}`);
  await db.storageLocation.createMany({ data: rows });
  await audit(user, { action: "warehouse.locations_created", entityType: "location", entityId: shelf.id, data: { codes: rows.map((r) => r.code) } });
  return db.storageLocation.findMany({ where: { organizationId: user.organizationId, code: { in: rows.map((r) => r.code) } }, orderBy: { sortKey: "asc" } });
}

export const locationPatchSchema = z.object({
  sizeClass: z.enum(BOOK_SIZES).nullish(),
  capacity: z.number().int().min(1).max(10000).nullish(),
  isFull: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullish(),
  active: z.boolean().optional(),
});

export async function updateLocation(user: UserPrincipal, id: string, input: z.infer<typeof locationPatchSchema>) {
  const loc = await db.storageLocation.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!loc) throw notFound("המיקום");
  if (input.active === false) {
    const n = await db.inventoryItem.count({ where: { currentLocationId: id } });
    if (n) throw new AppError("CONFLICT", `במיקום ${n} ספרים — העבירו אותם לפני השבתה`);
  }
  const u = await db.storageLocation.update({ where: { id }, data: input });
  await audit(user, { action: "warehouse.location_updated", entityType: "location", entityId: id, data: input as object });
  return u;
}

export async function findLocationByCode(orgId: string, raw: string, tx: Tx = db) {
  return tx.storageLocation.findFirst({ where: { organizationId: orgId, code: raw.trim().toUpperCase() }, include: locationInclude });
}

export async function getLocation(orgId: string, id: string) {
  return db.storageLocation.findFirst({ where: { id, organizationId: orgId }, include: locationInclude });
}

/** Warehouses → zones → shelves → locations, with how many books each location holds. */
export async function warehouseTree(orgId: string) {
  const [warehouses, counts] = await Promise.all([
    db.warehouse.findMany({
      where: { organizationId: orgId },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
      include: { zones: { orderBy: { sortOrder: "asc" }, include: { shelves: { orderBy: { sortOrder: "asc" }, include: { locations: { orderBy: { sortKey: "asc" } } } } } } },
    }),
    db.inventoryItem.groupBy({ by: ["currentLocationId"], where: { organizationId: orgId, currentLocationId: { not: null } }, _count: { _all: true } }),
  ]);
  const byLoc = new Map(counts.map((c) => [c.currentLocationId!, c._count._all]));
  return warehouses.map((w) => ({
    ...w,
    zones: w.zones.map((z) => ({
      ...z,
      shelves: z.shelves.map((s) => ({ ...s, locations: s.locations.map((l) => ({ ...l, itemCount: byLoc.get(l.id) ?? 0 })) })),
    })),
  }));
}

/**
 * Suggests shelf places for a book: active, not marked full, under capacity,
 * matching the book's size class when both are known. Dimensions are optional —
 * without them any free location qualifies.
 */
export async function suggestLocations(orgId: string, itemId: string, limit = 3) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: orgId }, select: { sizeCategory: true } });
  if (!item) return [];
  const locs = await db.storageLocation.findMany({
    where: {
      organizationId: orgId,
      active: true,
      isFull: false,
      ...(item.sizeCategory !== "UNKNOWN" ? { OR: [{ sizeClass: item.sizeCategory }, { sizeClass: null }, { sizeClass: "UNKNOWN" }] } : {}),
    },
    include: { ...locationInclude, _count: { select: { items: true } } },
    orderBy: { sortKey: "asc" },
    take: 500,
  });
  return locs
    .filter((l) => l.capacity === null || l._count.items < l.capacity)
    .map((l) => ({
      id: l.id,
      code: l.code,
      label: locationLabel(l),
      items: l._count.items,
      capacity: l.capacity,
      exactSize: l.sizeClass === item.sizeCategory && item.sizeCategory !== "UNKNOWN",
    }))
    .sort((a, b) => Number(b.exactSize) - Number(a.exactSize) || (a.capacity ? a.items / a.capacity : 0.5) - (b.capacity ? b.items / b.capacity : 0.5))
    .slice(0, limit);
}

/**
 * The one place a book's location changes. Records the movement (idempotent
 * on opId) and moves the physical status to IN_STORAGE when the book is
 * placed on a shelf from "awaiting storage" / "missing".
 */
export async function moveItemTx(
  tx: Tx,
  principal: Principal,
  itemId: string,
  toLocationId: string | null,
  kind: "STORE" | "TRANSFER" | "PICK" | "RETURN" | "COUNT_ADJUST" | "MANUAL",
  opts: { opId?: string | null; occurredAt?: Date; note?: string | null } = {},
) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  if (toLocationId) {
    const blocked = storeBlockedReason(item.physicalStatus);
    if (blocked && kind !== "RETURN") throw new AppError("CONFLICT", blocked);
  }
  const occurredAt = opts.occurredAt ?? new Date();
  await tx.inventoryLocationMovement.create({
    data: {
      organizationId: item.organizationId,
      inventoryItemId: itemId,
      fromLocationId: item.currentLocationId,
      toLocationId,
      kind,
      userId: principal.kind === "user" ? principal.userId : null,
      opId: opts.opId ?? null,
      occurredAt,
      note: opts.note ?? null,
    },
  });
  await tx.inventoryItem.update({ where: { id: itemId }, data: { currentLocationId: toLocationId, locationUpdatedAt: occurredAt } });
  if (toLocationId && (item.physicalStatus === "AWAITING_STORAGE" || item.physicalStatus === "MISSING" || kind === "RETURN")) {
    await changeStatus(tx, principal, itemId, "PHYSICAL", "IN_STORAGE", { refType: "movement", reason: kind === "RETURN" ? "הוחזר למדף" : null });
  }
  return { from: item.currentLocationId, to: toLocationId };
}

export const manualMoveSchema = z.object({ locationId: z.string().uuid().nullable(), note: z.string().trim().max(500).nullish() });

/** Desktop correction of a location (warehouse.manage). Scanner moves go through scanning.ts. */
export async function manualMove(user: UserPrincipal, itemId: string, input: z.infer<typeof manualMoveSchema>) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId } });
  if (!item) throw notFound("הספר");
  if (input.locationId) {
    const loc = await db.storageLocation.findFirst({ where: { id: input.locationId, organizationId: user.organizationId, active: true } });
    if (!loc) throw notFound("המיקום");
  }
  await db.$transaction((tx) => moveItemTx(tx, user, itemId, input.locationId, "MANUAL", { note: input.note ?? null }));
  await audit(user, { action: "warehouse.item_moved", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { to: input.locationId, note: input.note ?? null } });
}

/** Contents of a location — for the warehouse screen and the handheld's "find". */
export async function locationContents(orgId: string, locationId: string) {
  return db.inventoryItem.findMany({
    where: { organizationId: orgId, currentLocationId: locationId },
    orderBy: { serial: "asc" },
    select: { id: true, inventoryNumber: true, title: true, physicalStatus: true, commercialStatus: true },
    take: 1000,
  });
}

export const bulkMoveSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  locationId: z.string().uuid().nullable(),
  note: z.string().trim().max(500).nullish(),
});

/**
 * Places several books on one shelf. Each book is its own transaction so one blocked book (shipped,
 * picked …) never stops the rest; the result lists what failed and why.
 */
export async function bulkManualMove(user: UserPrincipal, input: z.infer<typeof bulkMoveSchema>) {
  if (input.locationId) {
    const loc = await db.storageLocation.findFirst({ where: { id: input.locationId, organizationId: user.organizationId, active: true } });
    if (!loc) throw notFound("המיקום");
  }
  const done: string[] = [];
  const failed: { itemId: string; message: string }[] = [];
  for (const itemId of input.itemIds) {
    try {
      const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId, deletionRequestedAt: null }, select: { id: true, currentLocationId: true } });
      if (!item) throw notFound("הספר");
      if (item.currentLocationId === input.locationId) {
        done.push(itemId);
        continue;
      }
      await db.$transaction((tx) => moveItemTx(tx, user, itemId, input.locationId, "MANUAL", { note: input.note ?? null }));
      done.push(itemId);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      failed.push({ itemId, message: err.message });
    }
  }
  if (done.length) await audit(user, { action: "warehouse.items_moved", entityType: "warehouse", entityId: input.locationId, data: { to: input.locationId, count: done.length } });
  return { done, failed };
}
