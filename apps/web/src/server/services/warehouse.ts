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


/* ───────────────────────── simple structure: warehouse → column → shelf ─────────────────────────
 * UI vocabulary maps onto the stored hierarchy: Warehouse = warehouse, WarehouseZone = column,
 * Shelf = shelf, and every shelf gets ONE StorageLocation (cell "01") — the exact place a book is
 * assigned to. Cells stay available as an advanced mechanism (createLocations). Codes are written once
 * and never changed or reused, so printed barcodes stay valid however the structure is edited later.
 */

const MAX_LOCATIONS_PER_CALL = 2000;

export const warehouseWizardSchema = z.object({
  name: z.string().trim().min(1, "שם המחסן נדרש").max(100),
  columns: z.number().int().min(1, "לפחות עמודה אחת").max(99),
  shelvesPerColumn: z.number().int().min(1, "לפחות מדף אחד בכל עמודה").max(99),
});

const pad2 = (n: number) => String(n).padStart(2, "0");

async function nextWarehouseCode(tx: Tx, orgId: string) {
  const existing = new Set((await tx.warehouse.findMany({ where: { organizationId: orgId }, select: { code: true } })).map((w) => w.code));
  for (let n = 1; n < 1000; n++) if (!existing.has(`W${n}`)) return `W${n}`;
  throw new AppError("CONFLICT", "יותר מדי מחסנים");
}

/** Creates a column with `shelves` shelves, each with its single location. Codes continue after the highest existing one. */
async function createColumnTx(tx: Tx, orgId: string, wh: { id: string; code: string; isDefault: boolean }, shelves: number, name?: string | null) {
  const zones = await tx.warehouseZone.findMany({ where: { warehouseId: wh.id }, select: { code: true, sortOrder: true } });
  const used = zones.map((z) => /^C(\d+)$/.exec(z.code)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
  const index = Math.max(0, ...used) + 1;
  if (index > 99) throw new AppError("CONFLICT", "מספר העמודות המרבי במחסן הוא 99");
  const zone = await tx.warehouseZone.create({
    data: { warehouseId: wh.id, code: `C${index}`, name: name?.trim() || `עמודה ${index}`, sortOrder: Math.max(0, ...zones.map((z) => z.sortOrder)) + 1 },
  });
  await addShelvesTx(tx, orgId, wh, zone, shelves);
  return zone;
}

async function addShelvesTx(tx: Tx, orgId: string, wh: { code: string; isDefault: boolean }, zone: { id: string; code: string }, count: number) {
  const shelves = await tx.shelf.findMany({ where: { zoneId: zone.id }, select: { code: true, sortOrder: true } });
  const used = shelves.map((s) => Number(s.code)).filter((n) => Number.isInteger(n));
  const start = Math.max(0, ...used) + 1;
  if (start + count - 1 > 99) throw new AppError("CONFLICT", "מספר המדפים המרבי בעמודה הוא 99");
  let order = Math.max(0, ...shelves.map((s) => s.sortOrder));
  for (let i = 0; i < count; i++) {
    const code = pad2(start + i);
    const shelf = await tx.shelf.create({ data: { zoneId: zone.id, code, sortOrder: ++order } });
    await tx.storageLocation.create({
      data: {
        organizationId: orgId,
        shelfId: shelf.id,
        cell: "01",
        code: formatLocationCode({ warehouse: wh.isDefault ? null : wh.code, zone: zone.code, shelf: code, cell: "01" }),
        sortKey: sortKey(wh.code, zone.code, code, "01"),
      },
    });
  }
}

/** The wizard: "מחסן 1, 8 עמודות, 5 מדפים בכל עמודה" → 40 shelves with locations and barcodes, atomically. */
export async function createWarehouseFromWizard(user: UserPrincipal, input: z.infer<typeof warehouseWizardSchema>) {
  if (input.columns * input.shelvesPerColumn > MAX_LOCATIONS_PER_CALL) throw new AppError("VALIDATION", "המבנה גדול מדי ליצירה אחת");
  const name = input.name.trim();
  const dup = await db.warehouse.findFirst({ where: { organizationId: user.organizationId, name } });
  if (dup) throw new AppError("CONFLICT", `מחסן בשם "${name}" כבר קיים`);
  const wh = await db.$transaction(
    async (tx) => {
      const first = (await tx.warehouse.count({ where: { organizationId: user.organizationId } })) === 0;
      const warehouse = await tx.warehouse.create({ data: { organizationId: user.organizationId, code: await nextWarehouseCode(tx, user.organizationId), name, isDefault: first } });
      for (let c = 0; c < input.columns; c++) await createColumnTx(tx, user.organizationId, warehouse, input.shelvesPerColumn);
      return warehouse;
    },
    { timeout: 120_000 },
  );
  await audit(user, { action: "warehouse.wizard_created", entityType: "warehouse", entityId: wh.id, data: { name, columns: input.columns, shelvesPerColumn: input.shelvesPerColumn } });
  return wh;
}

export const addColumnSchema = z.object({ warehouseId: z.string().uuid(), shelves: z.number().int().min(1).max(99), name: z.string().trim().max(100).nullish() });

export async function addColumn(user: UserPrincipal, input: z.infer<typeof addColumnSchema>) {
  const wh = await db.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: user.organizationId } });
  if (!wh) throw notFound("המחסן");
  const zone = await db.$transaction((tx) => createColumnTx(tx, user.organizationId, wh, input.shelves, input.name), { timeout: 60_000 });
  await audit(user, { action: "warehouse.column_added", entityType: "warehouse", entityId: zone.id, data: { code: zone.code, shelves: input.shelves } });
  return zone;
}

export const addShelvesSchema = z.object({ zoneId: z.string().uuid(), count: z.number().int().min(1).max(99) });

export async function addShelvesToColumn(user: UserPrincipal, input: z.infer<typeof addShelvesSchema>) {
  const zone = await zoneOf(user.organizationId, input.zoneId);
  await db.$transaction((tx) => addShelvesTx(tx, user.organizationId, zone.warehouse, zone, input.count), { timeout: 60_000 });
  await audit(user, { action: "warehouse.shelves_added", entityType: "warehouse", entityId: zone.id, data: { count: input.count } });
}

export const renameSchema = z.object({ name: z.string().trim().min(1).max(100) });

/** Display names only. Codes (and so printed barcodes) are never edited. */
export async function renameWarehouse(user: UserPrincipal, id: string, name: string) {
  const wh = await db.warehouse.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!wh) throw notFound("המחסן");
  const clash = await db.warehouse.findFirst({ where: { organizationId: user.organizationId, name, id: { not: id } } });
  if (clash) throw new AppError("CONFLICT", `מחסן בשם "${name}" כבר קיים`);
  const u = await db.warehouse.update({ where: { id }, data: { name } });
  await audit(user, { action: "warehouse.renamed", entityType: "warehouse", entityId: id, data: { from: wh.name, to: name } });
  return u;
}

export async function renameColumn(user: UserPrincipal, id: string, name: string) {
  const zone = await zoneOf(user.organizationId, id);
  const u = await db.warehouseZone.update({ where: { id }, data: { name } });
  await audit(user, { action: "warehouse.column_renamed", entityType: "warehouse", entityId: id, data: { from: zone.name, to: name } });
  return u;
}

export const reorderSchema = z.object({ kind: z.enum(["columns", "shelves"]), parentId: z.string().uuid(), orderedIds: z.array(z.string().uuid()).min(1).max(200) });

/** Display order only (sortOrder) — never touches codes or the location sort keys used for pick routes. */
export async function reorderStructure(user: UserPrincipal, input: z.infer<typeof reorderSchema>) {
  if (input.kind === "columns") {
    const wh = await db.warehouse.findFirst({ where: { id: input.parentId, organizationId: user.organizationId }, include: { zones: { select: { id: true } } } });
    if (!wh) throw notFound("המחסן");
    const valid = new Set(wh.zones.map((z) => z.id));
    if (input.orderedIds.length !== valid.size || input.orderedIds.some((id) => !valid.has(id))) throw new AppError("VALIDATION", "רשימת העמודות אינה תואמת");
    await db.$transaction(input.orderedIds.map((id, i) => db.warehouseZone.update({ where: { id }, data: { sortOrder: i + 1 } })));
  } else {
    const zone = await zoneOf(user.organizationId, input.parentId);
    const shelves = await db.shelf.findMany({ where: { zoneId: zone.id }, select: { id: true } });
    const valid = new Set(shelves.map((s) => s.id));
    if (input.orderedIds.length !== valid.size || input.orderedIds.some((id) => !valid.has(id))) throw new AppError("VALIDATION", "רשימת המדפים אינה תואמת");
    await db.$transaction(input.orderedIds.map((id, i) => db.shelf.update({ where: { id }, data: { sortOrder: i + 1 } })));
  }
  await audit(user, { action: "warehouse.reordered", entityType: "warehouse", entityId: input.parentId, data: { kind: input.kind } });
}

/** Disables / re-enables a shelf (all its locations). Disabling is refused while books are on it. */
export async function setShelfActive(user: UserPrincipal, shelfId: string, active: boolean) {
  const shelf = await db.shelf.findFirst({ where: { id: shelfId, zone: { warehouse: { organizationId: user.organizationId } } }, include: { locations: { select: { id: true } } } });
  if (!shelf) throw notFound("המדף");
  if (!active) {
    const n = await db.inventoryItem.count({ where: { currentLocationId: { in: shelf.locations.map((l) => l.id) } } });
    if (n) throw new AppError("CONFLICT", `על המדף ${n} ספרים — העבירו אותם לפני השבתה`);
  }
  await db.storageLocation.updateMany({ where: { shelfId }, data: { active } });
  await audit(user, { action: active ? "warehouse.shelf_enabled" : "warehouse.shelf_disabled", entityType: "warehouse", entityId: shelfId });
}

/** The books on a shelf (all its locations) for the "click a shelf" panel. */
export async function shelfContents(orgId: string, shelfId: string) {
  const shelf = await db.shelf.findFirst({ where: { id: shelfId, zone: { warehouse: { organizationId: orgId } } }, include: { zone: { include: { warehouse: true } }, locations: true } });
  if (!shelf) throw notFound("המדף");
  const items = await db.inventoryItem.findMany({
    where: { organizationId: orgId, currentLocationId: { in: shelf.locations.map((l) => l.id) }, deletionRequestedAt: null },
    orderBy: { serial: "asc" },
    take: 500,
    select: { id: true, inventoryNumber: true, title: true, author: true, physicalStatus: true, primaryAssetId: true, currentLocation: { select: { code: true } } },
  });
  return {
    shelf: { id: shelf.id, code: shelf.code, zone: shelf.zone.name, warehouse: shelf.zone.warehouse.name, locations: shelf.locations.map((l) => ({ id: l.id, code: l.code, cell: l.cell, active: l.active })) },
    items: items.map((i) => ({ id: i.id, inventoryNumber: i.inventoryNumber, title: i.title, author: i.author, physicalStatus: i.physicalStatus, thumbAssetId: i.primaryAssetId, locationCode: i.currentLocation?.code ?? null })),
  };
}
