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
  const zone = await db.warehouseZone.findFirst({ where: { id: zoneId, deletedAt: null, warehouse: { organizationId: orgId } }, include: { warehouse: true } });
  if (!zone) throw notFound("האזור");
  return zone;
}

export async function createShelf(user: UserPrincipal, input: z.infer<typeof shelfSchema>) {
  const zone = await zoneOf(user.organizationId, input.zoneId);
  const clash = await db.shelf.findUnique({ where: { zoneId_code: { zoneId: input.zoneId, code: input.code } } });
  if (clash) throw new AppError("CONFLICT", `מדף ${input.code} כבר קיים בעמודה`);
  const wh = zone.warehouse;
  const locCode = formatLocationCode({ warehouse: wh.isDefault ? null : wh.code, zone: zone.code, shelf: input.code });
  const s = await db.$transaction(async (tx) => {
    if (await codeTaken(tx, user.organizationId, locCode)) throw new AppError("CONFLICT", `הקוד ${locCode} כבר היה בשימוש (מדף שנמחק) ולא ניתן לשימוש חוזר`);
    const count = await tx.shelf.count({ where: { zoneId: input.zoneId } });
    const shelf = await tx.shelf.create({ data: { zoneId: input.zoneId, code: input.code, shelfType: input.shelfType ?? null, notes: input.notes ?? null, sortOrder: count + 1 } });
    // one location per shelf — the place a book is assigned to
    await tx.storageLocation.create({ data: { organizationId: user.organizationId, shelfId: shelf.id, cell: "01", code: locCode, sortKey: sortKey(wh.code, zone.code, input.code) } });
    return shelf;
  });
  await audit(user, { action: "warehouse.shelf_created", entityType: "warehouse", entityId: s.id, data: { code: s.code } });
  return s;
}

/** sortable key: warehouse/column/shelf, numeric parts zero-padded so "A-10" sorts after "A-9" */
function sortKey(...parts: string[]) {
  return parts.map((p) => p.replace(/\d+/g, (d) => d.padStart(4, "0"))).join("/");
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

/**
 * A shelf by its scanned code: the current one ("LOC-W1-C4-04") or a former one printed when shelves still had
 * cells ("LOC-W1-C4-04-01"). Never a merged cell row; the alias points at the shelf's own location.
 */
export async function findLocationByCode(orgId: string, raw: string, tx: Tx = db) {
  const value = raw.trim().toUpperCase();
  return tx.storageLocation.findFirst({
    where: { organizationId: orgId, mergedIntoId: null, OR: [{ code: value }, { aliases: { some: { alias: value } } }] },
    include: locationInclude,
  });
}

/** True for the code of a shelf that was deleted: it stays reserved and never points at another shelf. */
export async function isRetiredLocationCode(orgId: string, raw: string, tx: Tx = db) {
  const value = raw.trim().toUpperCase();
  return !!(await tx.storageLocationAlias.findFirst({ where: { organizationId: orgId, alias: value, locationId: null }, select: { id: true } }));
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
      include: {
        zones: {
          where: { deletedAt: null },
          orderBy: { sortOrder: "asc" },
          include: { shelves: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { locations: { where: { mergedIntoId: null }, orderBy: { sortKey: "asc" }, include: { aliases: { select: { alias: true } } } } } } },
        },
      },
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
      mergedIntoId: null,
      shelf: { deletedAt: null, zone: { deletedAt: null } },
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
 * Shelf = shelf, and every shelf has exactly ONE StorageLocation — the exact place a book is assigned to.
 * There are no cells. Codes are written once and never changed or reused, so printed barcodes stay valid
 * however the structure is edited or shrunk later.
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

/** True when a code is (or ever was) used by a location of this organization — including deleted shelves. */
async function codeTaken(tx: Tx, orgId: string, codeValue: string) {
  const [loc, alias] = await Promise.all([
    tx.storageLocation.findFirst({ where: { organizationId: orgId, code: codeValue }, select: { id: true } }),
    tx.storageLocationAlias.findFirst({ where: { organizationId: orgId, alias: codeValue }, select: { id: true } }),
  ]);
  return !!(loc || alias);
}

/** Creates a column with `shelves` shelves, each with its single location. Codes continue after the highest existing one (deleted columns count). */
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
  // every shelf of the column counts, deleted ones too: a shelf number (and its printed barcode) is never given again
  const shelves = await tx.shelf.findMany({ where: { zoneId: zone.id }, select: { code: true, sortOrder: true } });
  const used = shelves.map((s) => Number(s.code)).filter((n) => Number.isInteger(n));
  let next = Math.max(0, ...used) + 1;
  let order = Math.max(0, ...shelves.map((s) => s.sortOrder));
  for (let i = 0; i < count; i++) {
    let codeStr = pad2(next);
    let locCode = formatLocationCode({ warehouse: wh.isDefault ? null : wh.code, zone: zone.code, shelf: codeStr });
    while (await codeTaken(tx, orgId, locCode)) {
      next++;
      codeStr = pad2(next);
      locCode = formatLocationCode({ warehouse: wh.isDefault ? null : wh.code, zone: zone.code, shelf: codeStr });
    }
    if (next > 99) throw new AppError("CONFLICT", "מספר המדפים המרבי בעמודה הוא 99");
    const shelf = await tx.shelf.create({ data: { zoneId: zone.id, code: codeStr, sortOrder: ++order } });
    // one location per shelf — "cell" is a legacy column and is always "01"
    await tx.storageLocation.create({ data: { organizationId: orgId, shelfId: shelf.id, cell: "01", code: locCode, sortKey: sortKey(wh.code, zone.code, codeStr) } });
    next++;
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

/** Disables / re-enables a shelf's location. Disabling is refused while books are on it. */
export async function setShelfActive(user: UserPrincipal, shelfId: string, active: boolean) {
  const shelf = await db.shelf.findFirst({ where: { id: shelfId, deletedAt: null, zone: { deletedAt: null, warehouse: { organizationId: user.organizationId } } }, include: { locations: { where: { mergedIntoId: null }, select: { id: true } } } });
  if (!shelf) throw notFound("המדף");
  if (!active) {
    const n = await db.inventoryItem.count({ where: { currentLocationId: { in: shelf.locations.map((l) => l.id) } } });
    if (n) throw new AppError("CONFLICT", `על המדף ${n} ספרים — העבירו אותם לפני השבתה`);
  }
  await db.storageLocation.updateMany({ where: { shelfId, mergedIntoId: null }, data: { active } });
  await audit(user, { action: active ? "warehouse.shelf_enabled" : "warehouse.shelf_disabled", entityType: "warehouse", entityId: shelfId });
}

/** The books on a shelf (all its locations) for the "click a shelf" panel. */
export async function shelfContents(orgId: string, shelfId: string) {
  const shelf = await db.shelf.findFirst({ where: { id: shelfId, deletedAt: null, zone: { warehouse: { organizationId: orgId } } }, include: { zone: { include: { warehouse: true } }, locations: { where: { mergedIntoId: null } } } });
  if (!shelf) throw notFound("המדף");
  const items = await db.inventoryItem.findMany({
    where: { organizationId: orgId, currentLocationId: { in: shelf.locations.map((l) => l.id) }, deletionRequestedAt: null },
    orderBy: { serial: "asc" },
    take: 500,
    select: { id: true, inventoryNumber: true, title: true, author: true, physicalStatus: true, primaryAssetId: true },
  });
  return {
    shelf: {
      id: shelf.id,
      code: shelf.code,
      label: locationLabel({ shelf: { code: shelf.code, zone: { code: shelf.zone.code, name: shelf.zone.name, warehouse: shelf.zone.warehouse } } }),
      zone: shelf.zone.name,
      warehouse: shelf.zone.warehouse.name,
      locations: shelf.locations.map((l) => ({ id: l.id, active: l.active })),
    },
    items: items.map((i) => ({ id: i.id, inventoryNumber: i.inventoryNumber, title: i.title, author: i.author, physicalStatus: i.physicalStatus, thumbAssetId: i.primaryAssetId })),
  };
}


/* ───────────────────────── deleting shelves and columns ─────────────────────────
 * A shelf with no history at all is removed for real (its code is kept as a reserved alias, so it is never reused).
 * A shelf that ever held a book, was counted or scanned leaves the active structure (deletedAt) and stays as the
 * reference of that history. A column always leaves the structure logically — its code also stays reserved.
 * Books on a shelf are never deleted: they are moved to a shelf the manager chooses first.
 */

export interface ShelfDeletionInfo {
  id: string;
  label: string;
  books: number;
  /** true = the shelf has no history and will be removed for real; false = it only leaves the active structure */
  physical: boolean;
  /** an open stock count or pick task refers to it */
  blocked: string | null;
}

export interface DeletionPlan {
  shelves: ShelfDeletionInfo[];
  books: number;
  blocked: string | null;
}

async function shelfInfos(orgId: string, shelfIds: string[], tx: Tx = db) {
  const shelves = await tx.shelf.findMany({
    where: { id: { in: shelfIds }, deletedAt: null, zone: { warehouse: { organizationId: orgId } } },
    include: { zone: { include: { warehouse: true } }, locations: { select: { id: true, code: true } } },
    orderBy: [{ zone: { sortOrder: "asc" } }, { sortOrder: "asc" }],
  });
  if (shelves.length !== new Set(shelfIds).size) throw notFound("המדף");
  const locIds = shelves.flatMap((s) => s.locations.map((l) => l.id));
  const [books, moves, scans, countLocs, countEntries, picks, openCounts, openPicks] = await Promise.all([
    tx.inventoryItem.groupBy({ by: ["currentLocationId"], where: { currentLocationId: { in: locIds } }, _count: { _all: true } }),
    tx.inventoryLocationMovement.findMany({ where: { OR: [{ fromLocationId: { in: locIds } }, { toLocationId: { in: locIds } }] }, select: { fromLocationId: true, toLocationId: true } }),
    tx.barcodeScanEvent.findMany({ where: { OR: [{ locationId: { in: locIds } }, { contextLocationId: { in: locIds } }] }, select: { locationId: true, contextLocationId: true } }),
    tx.stockCountLocation.findMany({ where: { locationId: { in: locIds } }, select: { locationId: true } }),
    tx.stockCountEntry.findMany({ where: { OR: [{ locationId: { in: locIds } }, { expectedLocationId: { in: locIds } }] }, select: { locationId: true, expectedLocationId: true } }),
    tx.pickTask.findMany({ where: { sourceLocationId: { in: locIds } }, select: { sourceLocationId: true } }),
    tx.stockCountLocation.findMany({ where: { locationId: { in: locIds }, session: { status: "OPEN" } }, select: { locationId: true } }),
    tx.pickTask.findMany({ where: { sourceLocationId: { in: locIds }, status: { in: ["OPEN", "PICKED", "PACKED"] } }, select: { sourceLocationId: true } }),
  ]);
  const touched = new Set<string>();
  for (const m of moves) [m.fromLocationId, m.toLocationId].forEach((x) => x && touched.add(x));
  for (const e of scans) [e.locationId, e.contextLocationId].forEach((x) => x && touched.add(x));
  for (const c of countLocs) touched.add(c.locationId);
  for (const c of countEntries) [c.locationId, c.expectedLocationId].forEach((x) => x && touched.add(x));
  for (const p of picks) p.sourceLocationId && touched.add(p.sourceLocationId);
  const booksBy = new Map(books.map((b) => [b.currentLocationId!, b._count._all]));
  const openCount = new Set(openCounts.map((c) => c.locationId));
  const openPick = new Set(openPicks.map((p) => p.sourceLocationId!));
  return shelves.map((s) => {
    const ids = s.locations.map((l) => l.id);
    const n = ids.reduce((a, id) => a + (booksBy.get(id) ?? 0), 0);
    const history = ids.some((id) => touched.has(id)) || n > 0 || s.locations.length > 1;
    const blocked = ids.some((id) => openCount.has(id)) ? "ספירת מלאי פעילה כוללת את המדף" : ids.some((id) => openPick.has(id)) ? "קיימת משימת ליקוט פתוחה מהמדף" : null;
    return {
      shelf: s,
      info: {
        id: s.id,
        label: locationLabel({ shelf: { code: s.code, zone: { code: s.zone.code, name: s.zone.name, warehouse: s.zone.warehouse } } }),
        books: n,
        // having held a book once is history even when the shelf is empty now: books show "where they were"
        physical: !history,
        blocked,
      } satisfies ShelfDeletionInfo,
    };
  });
}

function toPlan(rows: { info: ShelfDeletionInfo }[]): DeletionPlan {
  const infos = rows.map((r) => r.info);
  return { shelves: infos, books: infos.reduce((a, i) => a + i.books, 0), blocked: infos.find((i) => i.blocked)?.blocked ?? null };
}

export async function planShelfDeletion(user: UserPrincipal, shelfIds: string[]): Promise<DeletionPlan> {
  return toPlan(await shelfInfos(user.organizationId, shelfIds));
}

export const deleteShelvesSchema = z.object({
  shelfIds: z.array(z.string().uuid()).min(1).max(300),
  /** where the books go when the shelves are not empty (an active location outside the deleted shelves) */
  moveToLocationId: z.string().uuid().nullish(),
});

async function removeShelvesTx(tx: Tx, user: UserPrincipal, rows: Awaited<ReturnType<typeof shelfInfos>>, moveTo: string | null) {
  const locIds = rows.flatMap((r) => r.shelf.locations.map((l) => l.id));
  if (rows.some((r) => r.info.blocked)) throw new AppError("CONFLICT", rows.find((r) => r.info.blocked)!.info.blocked!);
  const books = await tx.inventoryItem.findMany({ where: { currentLocationId: { in: locIds } }, select: { id: true } });
  if (books.length) {
    if (!moveTo) throw new AppError("CONFLICT", `על המדפים ${books.length} ספרים — בחרו מדף להעברה`);
    if (locIds.includes(moveTo)) throw new AppError("VALIDATION", "מדף היעד נמצא בין המדפים שנמחקים");
    const target = await tx.storageLocation.findFirst({ where: { id: moveTo, organizationId: user.organizationId, active: true, mergedIntoId: null, shelf: { deletedAt: null, zone: { deletedAt: null } } } });
    if (!target) throw notFound("מדף היעד");
    for (const b of books) await moveItemTx(tx, user, b.id, moveTo, "TRANSFER", { note: "הועבר לפני מחיקת מדף" });
  }
  let physical = 0;
  let logical = 0;
  for (const { shelf, info } of rows) {
    if (info.physical) {
      // keep the codes reserved, then remove the rows (aliases of the deleted locations are set to "retired")
      for (const l of shelf.locations) {
        await tx.storageLocationAlias.upsert({
          where: { organizationId_alias: { organizationId: user.organizationId, alias: l.code } },
          create: { organizationId: user.organizationId, alias: l.code, locationId: null },
          update: { locationId: null },
        });
      }
      await tx.storageLocation.deleteMany({ where: { shelfId: shelf.id } });
      await tx.shelf.delete({ where: { id: shelf.id } });
      physical++;
    } else {
      await tx.storageLocation.updateMany({ where: { shelfId: shelf.id }, data: { active: false } });
      await tx.shelf.update({ where: { id: shelf.id }, data: { deletedAt: new Date() } });
      logical++;
    }
  }
  return { moved: books.length, physical, logical };
}

/** "מחק מדף" / "מחק מדפים": books must be moved first; history is kept (see above). */
export async function deleteShelves(user: UserPrincipal, input: z.infer<typeof deleteShelvesSchema>) {
  const result = await db.$transaction(
    async (tx) => removeShelvesTx(tx, user, await shelfInfos(user.organizationId, input.shelfIds, tx), input.moveToLocationId ?? null),
    { timeout: 120_000 },
  );
  await audit(user, { action: "warehouse.shelves_deleted", entityType: "warehouse", entityId: input.shelfIds[0], data: { shelves: input.shelfIds.length, ...result, moveTo: input.moveToLocationId ?? null } });
  return result;
}

/** "מחק מדפים ריקים": every shelf of the column that holds no book (and has no open count / pick). */
export async function deleteEmptyShelves(user: UserPrincipal, zoneId: string, dryRun = false) {
  const zone = await zoneOf(user.organizationId, zoneId);
  const shelves = await db.shelf.findMany({ where: { zoneId: zone.id, deletedAt: null }, select: { id: true } });
  if (!shelves.length) return { count: 0, removed: [] as string[] };
  const rows = (await shelfInfos(user.organizationId, shelves.map((s) => s.id))).filter((r) => r.info.books === 0 && !r.info.blocked);
  const labels = rows.map((r) => r.info.label);
  if (dryRun || !rows.length) return { count: rows.length, removed: labels };
  const result = await db.$transaction((tx) => removeShelvesTx(tx, user, rows, null), { timeout: 120_000 });
  await audit(user, { action: "warehouse.empty_shelves_deleted", entityType: "warehouse", entityId: zone.id, data: { column: zone.code, ...result } });
  return { count: rows.length, removed: labels };
}

export const deleteColumnSchema = z.object({ moveToLocationId: z.string().uuid().nullish() });

export async function planColumnDeletion(user: UserPrincipal, zoneId: string) {
  const zone = await zoneOf(user.organizationId, zoneId);
  const shelves = await db.shelf.findMany({ where: { zoneId: zone.id, deletedAt: null }, select: { id: true } });
  const plan = shelves.length ? toPlan(await shelfInfos(user.organizationId, shelves.map((s) => s.id))) : { shelves: [], books: 0, blocked: null };
  return { column: zone.name, ...plan };
}

/** "מחק עמודה": its shelves go the same way as above; the column itself leaves the structure and its code stays reserved. */
export async function deleteColumn(user: UserPrincipal, zoneId: string, input: z.infer<typeof deleteColumnSchema>) {
  const zone = await zoneOf(user.organizationId, zoneId);
  const result = await db.$transaction(
    async (tx) => {
      const shelves = await tx.shelf.findMany({ where: { zoneId: zone.id, deletedAt: null }, select: { id: true } });
      const r = shelves.length ? await removeShelvesTx(tx, user, await shelfInfos(user.organizationId, shelves.map((s) => s.id), tx), input.moveToLocationId ?? null) : { moved: 0, physical: 0, logical: 0 };
      await tx.warehouseZone.update({ where: { id: zone.id }, data: { deletedAt: new Date() } });
      return r;
    },
    { timeout: 120_000 },
  );
  await audit(user, { action: "warehouse.column_deleted", entityType: "warehouse", entityId: zone.id, data: { column: zone.code, name: zone.name, ...result, moveTo: input.moveToLocationId ?? null } });
  return result;
}
