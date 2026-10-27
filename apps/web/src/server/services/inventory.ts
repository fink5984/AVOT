import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { BOOK_SIZES, DEFAULT_REQUIREMENTS, PHOTO_CATEGORIES, classifyCode, formatInventoryNumber, type CategoryRequirements, type PhotoCategory } from "@avot/shared";
import { db, type Tx } from "../db";
import { asJson } from "../json";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { canSeeHouse } from "../auth/houses";
import { changeStatus } from "./item-status";
import { locationLabel, locationInclude } from "./location-label";

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const optionalMm = z.number().int().min(1).max(5000).nullish();

export const itemInputSchema = z.object({
  title: z.string().trim().min(1, "שם הספר נדרש").max(300),
  subtitle: optionalText(300),
  author: optionalText(200),
  printPlace: optionalText(200),
  printYear: optionalText(50),
  publisher: optionalText(200),
  bibliographicNotes: optionalText(5000),
  internalNotes: optionalText(5000),
  conditionNotes: optionalText(2000),
  heightMm: optionalMm,
  widthMm: optionalMm,
  depthMm: optionalMm,
  sizeCategory: z.enum(BOOK_SIZES).optional(),
  /** external tag already on the box / sleeve; default = the inventory number */
  barcode: z.string().trim().min(3).max(64).regex(/^[\x21-\x7e]+$/, "ברקוד: תווי ASCII בלבד").optional(),
  /** client-generated key of this create request: a double Enter / retried request returns the same book */
  opId: z.string().uuid().optional(),
});
export type ItemInput = z.input<typeof itemInputSchema>;
export const itemPatchSchema = itemInputSchema.omit({ opId: true }).partial();

/** Bibliographic fields copied to a lot when the book is assigned to a catalog. */
export const LOT_COPY_FIELDS = ["title", "subtitle", "author", "printYear", "printPlace"] as const;

/** Allocates the next inventory serial atomically. Never reused, gaps are fine. */
export async function allocateSerial(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    UPDATE "Organization" SET "inventorySerialSeq" = "inventorySerialSeq" + 1 WHERE id = ${orgId}::uuid RETURNING "inventorySerialSeq" AS seq`;
  return Number(rows[0]!.seq);
}

/** Size class from known dimensions (height drives shelf choice); UNKNOWN without dimensions. */
export function sizeFromDimensions(heightMm?: number | null, widthMm?: number | null): (typeof BOOK_SIZES)[number] {
  const h = Math.max(heightMm ?? 0, widthMm ?? 0);
  if (!h) return "UNKNOWN";
  if (h <= 200) return "SMALL";
  if (h <= 300) return "MEDIUM";
  if (h <= 420) return "LARGE";
  return "OVERSIZE";
}

export async function createItemTx(
  tx: Tx,
  principal: UserPrincipal,
  input: ItemInput,
  opts: { requirements?: CategoryRequirements } = {},
) {
  const serial = await allocateSerial(tx, principal.organizationId);
  const inventoryNumber = formatInventoryNumber(serial);
  const barcode = input.barcode ?? inventoryNumber;
  const clash = await tx.inventoryItem.findFirst({
    where: { organizationId: principal.organizationId, OR: [{ barcode }, { inventoryNumber: barcode }] },
    select: { inventoryNumber: true },
  });
  if (clash) throw new AppError("CONFLICT", `הברקוד ${barcode} כבר משויך לספר ${clash.inventoryNumber}`);
  const item = await tx.inventoryItem.create({
    data: {
      organizationId: principal.organizationId,
      serial,
      inventoryNumber,
      barcode,
      title: input.title,
      subtitle: input.subtitle ?? null,
      author: input.author ?? null,
      printPlace: input.printPlace ?? null,
      printYear: input.printYear ?? null,
      publisher: input.publisher ?? null,
      bibliographicNotes: input.bibliographicNotes ?? null,
      internalNotes: input.internalNotes ?? null,
      conditionNotes: input.conditionNotes ?? null,
      heightMm: input.heightMm ?? null,
      widthMm: input.widthMm ?? null,
      depthMm: input.depthMm ?? null,
      sizeCategory: input.sizeCategory && input.sizeCategory !== "UNKNOWN" ? input.sizeCategory : sizeFromDimensions(input.heightMm, input.widthMm),
      requirements: asJson(opts.requirements ?? DEFAULT_REQUIREMENTS),
      createdById: principal.userId,
      createOpId: input.opId ?? null,
    },
  });
  await tx.inventoryStatusEvent.createMany({
    data: (["PHOTO", "PHYSICAL", "COMMERCIAL"] as const).map((dimension) => ({
      organizationId: principal.organizationId,
      inventoryItemId: item.id,
      dimension,
      toStatus: dimension === "PHOTO" ? item.photoStatus : dimension === "PHYSICAL" ? item.physicalStatus : item.commercialStatus,
      userId: principal.userId,
      reason: "קליטה למלאי",
    })),
  });
  await audit(
    principal,
    { action: "inventory.created", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { inventoryNumber, title: item.title } },
    tx,
  );
  return item;
}

/** The book already created by a request with this key (null when none, or the key is absent). */
export async function findItemByOpId(orgId: string, opId: string | undefined, tx: Tx = db) {
  if (!opId) return null;
  return tx.inventoryItem.findUnique({ where: { organizationId_createOpId: { organizationId: orgId, createOpId: opId } } });
}

/**
 * Receives a book. Idempotent on `opId`: the same key (double Enter, a retry after a lost response,
 * two tabs racing) always yields the one book, never a second inventory number.
 */
export async function createItem(principal: UserPrincipal, input: ItemInput): Promise<{ item: Awaited<ReturnType<typeof createItemTx>>; existing: boolean }> {
  const prior = await findItemByOpId(principal.organizationId, input.opId);
  if (prior) return { item: prior, existing: true };
  try {
    return { item: await db.$transaction((tx) => createItemTx(tx, principal, input)), existing: false };
  } catch (err) {
    // lost the race against an identical request: its row is the answer
    const raced = await findItemByOpId(principal.organizationId, input.opId);
    if (raced) return { item: raced, existing: true };
    throw err;
  }
}

export async function getItemOrThrow(orgId: string, id: string, tx: Tx = db) {
  const item = await tx.inventoryItem.findFirst({ where: { id, organizationId: orgId } });
  if (!item) throw notFound("הספר");
  return item;
}

/**
 * Updates the book. Bibliographic changes flow into the ACTIVE lot only where
 * the lot still holds the previous item value — a catalog-specific edit of the
 * lot's title (or author …) is never overwritten.
 */
export async function updateItem(user: UserPrincipal, id: string, input: z.infer<typeof itemPatchSchema>) {
  const item = await getItemOrThrow(user.organizationId, id);
  if (input.barcode && input.barcode !== item.barcode) {
    const clash = await db.inventoryItem.findFirst({
      where: { organizationId: user.organizationId, id: { not: id }, OR: [{ barcode: input.barcode }, { inventoryNumber: input.barcode }] },
      select: { inventoryNumber: true },
    });
    if (clash) throw new AppError("CONFLICT", `הברקוד ${input.barcode} כבר משויך לספר ${clash.inventoryNumber}`);
  }
  const sizeCategory =
    input.sizeCategory ??
    (input.heightMm !== undefined || input.widthMm !== undefined
      ? item.sizeCategory === "UNKNOWN" || item.sizeCategory === sizeFromDimensions(item.heightMm, item.widthMm)
        ? sizeFromDimensions(input.heightMm === undefined ? item.heightMm : input.heightMm, input.widthMm === undefined ? item.widthMm : input.widthMm)
        : undefined
      : undefined);
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.inventoryItem.update({ where: { id }, data: { ...input, ...(sizeCategory ? { sizeCategory } : {}) } });
    const active = await tx.lot.findFirst({ where: { inventoryItemId: id, assignmentStatus: "ACTIVE" } });
    if (active) {
      const lotPatch: Record<string, string | null> = {};
      for (const f of LOT_COPY_FIELDS) {
        if (input[f] !== undefined && active[f] === item[f]) lotPatch[f] = input[f] ?? (f === "title" ? item.title : null);
      }
      if (Object.keys(lotPatch).length) await tx.lot.update({ where: { id: active.id }, data: lotPatch });
    }
    return u;
  });
  await audit(user, { action: "inventory.updated", entityType: "inventory", entityId: id, inventoryItemId: id, data: input as object });
  return updated;
}

export async function setItemPhotoStatus(user: UserPrincipal, id: string, status: z.infer<typeof photoStatusSchema>) {
  await getItemOrThrow(user.organizationId, id);
  const changed = await db.$transaction((tx) => changeStatus(tx, user, id, "PHOTO", status, { refType: "manual" }));
  if (changed) await audit(user, { action: "inventory.photo_status", entityType: "inventory", entityId: id, inventoryItemId: id, data: { status } });
}
export const photoStatusSchema = z.enum(["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"]);

/* ───────────────────────── listing ───────────────────────── */

export const INVENTORY_VIEWS = ["all", "no_catalog", "no_photos", "no_location", "missing", "awaiting_pick", "unsold"] as const;
export type InventoryView = (typeof INVENTORY_VIEWS)[number];

export interface InventoryListOptions {
  q?: string;
  view?: InventoryView;
  houseId?: string;
  /** hide books that already hold an ACTIVE assignment in this catalog (the "add from inventory" picker) */
  notInCatalogId?: string;
  photoStatus?: string;
  physicalStatus?: string;
  sort?: "updated" | "number" | "title";
  page?: number;
  pageSize?: number;
}

export function inventoryWhere(orgId: string, o: InventoryListOptions): Prisma.InventoryItemWhereInput {
  // books waiting for their permanent deletion are out of everyday work
  const and: Prisma.InventoryItemWhereInput[] = [{ organizationId: orgId, deletionRequestedAt: null }];
  const q = o.q?.trim();
  if (q) {
    const code = classifyCode(q);
    const serial = /^\d{1,9}$/.test(q) ? Number(q) : undefined;
    and.push({
      OR: [
        ...(code.type === "ITEM" ? [{ inventoryNumber: code.value }] : []),
        { barcode: q },
        ...(serial !== undefined ? [{ serial }] : []),
        { title: { contains: q, mode: "insensitive" } },
        { subtitle: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        { printPlace: { contains: q, mode: "insensitive" } },
        { printYear: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  switch (o.view) {
    case "no_catalog":
      and.push({ lots: { none: { assignmentStatus: "ACTIVE" } }, physicalStatus: { not: "SHIPPED" }, commercialStatus: { not: "SOLD" } });
      break;
    case "no_photos":
      and.push({ photoCount: 0 });
      break;
    case "no_location":
      and.push({ currentLocationId: null, physicalStatus: { notIn: ["SHIPPED", "PACKED", "PICKED"] } });
      break;
    case "missing":
      and.push({ physicalStatus: "MISSING" });
      break;
    case "awaiting_pick":
      and.push({ physicalStatus: "AWAITING_PICK" });
      break;
    case "unsold":
      and.push({ commercialStatus: "UNSOLD" });
      break;
  }
  if (o.notInCatalogId) and.push({ lots: { none: { catalogId: o.notInCatalogId, assignmentStatus: "ACTIVE" } } });
  if (o.houseId) and.push({ lots: { some: { assignmentStatus: "ACTIVE", catalog: { auctionHouseId: o.houseId } } } });
  if (o.photoStatus) and.push({ photoStatus: o.photoStatus as never });
  if (o.physicalStatus) and.push({ physicalStatus: o.physicalStatus as never });
  return { AND: and };
}

export async function listInventory(user: UserPrincipal, o: InventoryListOptions) {
  const pageSize = Math.min(Math.max(o.pageSize ?? 100, 1), 500);
  const page = Math.max(o.page ?? 1, 1);
  const where = inventoryWhere(user.organizationId, o);
  const [total, rows] = await Promise.all([
    db.inventoryItem.count({ where }),
    db.inventoryItem.findMany({
      where,
      orderBy: o.sort === "number" ? { serial: "asc" } : o.sort === "title" ? { title: "asc" } : { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        currentLocation: { include: locationInclude },
        lots: {
          where: { assignmentStatus: "ACTIVE" },
          include: { catalog: { select: { id: true, number: true, name: true, auctionHouse: { select: { id: true, slug: true, name: true, accentColor: true } } } } },
        },
      },
    }),
  ]);
  const needThumb = rows.filter((r) => !r.primaryAssetId && r.photoCount > 0).map((r) => r.id);
  const firstThumbs = needThumb.length
    ? await db.photoAsset.findMany({
        where: { inventoryItemId: { in: needThumb }, deletedAt: null, thumbKey: { not: null } },
        orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
        distinct: ["inventoryItemId"],
        select: { id: true, inventoryItemId: true },
      })
    : [];
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => {
      const lot = r.lots[0];
      const visible = lot ? canSeeHouse(user, lot.catalog.auctionHouse.id) : false;
      return {
        id: r.id,
        serial: r.serial,
        inventoryNumber: r.inventoryNumber,
        barcode: r.barcode,
        title: r.title,
        author: r.author,
        photoStatus: r.photoStatus,
        physicalStatus: r.physicalStatus,
        commercialStatus: r.commercialStatus,
        photoCount: r.photoCount,
        thumbAssetId: r.primaryAssetId ?? firstThumbs.find((t) => t.inventoryItemId === r.id)?.id ?? null,
        location: r.currentLocation ? { id: r.currentLocation.id, code: r.currentLocation.code, label: locationLabel(r.currentLocation) } : null,
        assignment: lot
          ? visible
            ? {
                lotId: lot.id,
                lotNumber: lot.lotNumber,
                commercialStatus: lot.commercialStatus,
                catalog: { id: lot.catalog.id, number: lot.catalog.number, name: lot.catalog.name },
                house: lot.catalog.auctionHouse,
              }
            : { hidden: true as const }
          : null,
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
  };
}
export type InventoryRow = Awaited<ReturnType<typeof listInventory>>["items"][number];

export async function inventoryCounts(orgId: string) {
  const views = INVENTORY_VIEWS.filter((v) => v !== "all");
  const counts = await Promise.all(views.map((view) => db.inventoryItem.count({ where: inventoryWhere(orgId, { view }) })));
  const total = await db.inventoryItem.count({ where: { organizationId: orgId, deletionRequestedAt: null } });
  return { all: total, ...Object.fromEntries(views.map((v, i) => [v, counts[i]!])) } as Record<InventoryView, number>;
}

/* ───────────────────────── lookup by code ───────────────────────── */

/** Finds a book by its printed tag (inventory number / registered barcode) or a legacy catalog label. */
export async function findItemByCode(orgId: string, raw: string, tx: Tx = db) {
  const code = classifyCode(raw);
  if (code.type === "LOT") {
    const lot = await tx.lot.findFirst({ where: { id: code.value, organizationId: orgId }, select: { inventoryItemId: true } });
    return lot ? tx.inventoryItem.findUnique({ where: { id: lot.inventoryItemId } }) : null;
  }
  const value = code.type === "ITEM" ? code.value : code.value.trim();
  if (!value) return null;
  return tx.inventoryItem.findFirst({ where: { organizationId: orgId, deletionRequestedAt: null, OR: [{ inventoryNumber: value }, { barcode: value }] } });
}

/* ───────────────────────── detail & history ───────────────────────── */

export async function getItemDetail(user: UserPrincipal, id: string) {
  const item = await db.inventoryItem.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      currentLocation: { include: locationInclude },
      categoryNotes: true,
      lots: {
        orderBy: { assignedAt: "desc" },
        include: { catalog: { select: { id: true, number: true, name: true, status: true, auctionHouse: { select: { id: true, slug: true, name: true, accentColor: true } } } } },
      },
      pickTasks: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!item) return null;
  const [events, moves, auditRows, counts] = await Promise.all([
    db.inventoryStatusEvent.findMany({ where: { inventoryItemId: id }, orderBy: { createdAt: "desc" }, take: 300 }),
    db.inventoryLocationMovement.findMany({
      where: { inventoryItemId: id },
      orderBy: { occurredAt: "desc" },
      take: 300,
      include: { from: { include: locationInclude }, to: { include: locationInclude } },
    }),
    db.auditLog.findMany({ where: { inventoryItemId: id }, orderBy: { createdAt: "desc" }, take: 300, include: { user: { select: { name: true } } } }),
    db.photoAsset.groupBy({ by: ["category"], where: { inventoryItemId: id, deletedAt: null }, _count: { _all: true } }),
  ]);
  const userIds = [...new Set([...events.map((e) => e.userId), ...moves.map((m) => m.userId)].filter((x): x is string => !!x))];
  const users = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    item,
    lots: item.lots.map((l) => ({ ...l, hidden: !canSeeHouse(user, l.catalog.auctionHouse.id) })),
    categoryCounts: Object.fromEntries(PHOTO_CATEGORIES.map((c) => [c, counts.find((x) => x.category === c)?._count._all ?? 0])) as Record<PhotoCategory, number>,
    events: events.map((e) => ({ ...e, userName: e.userId ? (users.get(e.userId) ?? null) : null })),
    moves: moves.map((m) => ({
      ...m,
      fromLabel: m.from ? locationLabel(m.from) : null,
      toLabel: m.to ? locationLabel(m.to) : null,
      userName: m.userId ? (users.get(m.userId) ?? null) : null,
    })),
    audit: auditRows,
  };
}

/* ───────────────────────── per-category photo progress ───────────────────────── */

export interface CategoryProgress {
  category: PhotoCategory;
  count: number;
  required: boolean;
  min: number;
  satisfied: boolean;
  needsReshoot: boolean;
  note: string | null;
}

/** Per-category counts vs. requirements; "complete" is a human decision, this only advises. */
export async function itemProgress(itemId: string): Promise<CategoryProgress[]> {
  const item = await db.inventoryItem.findUnique({ where: { id: itemId }, include: { categoryNotes: true } });
  if (!item) return [];
  const counts = await db.photoAsset.groupBy({ by: ["category"], where: { inventoryItemId: itemId, deletedAt: null }, _count: { _all: true } });
  const req = { ...DEFAULT_REQUIREMENTS, ...((item.requirements as Partial<CategoryRequirements>) ?? {}) };
  return PHOTO_CATEGORIES.map((category) => {
    const count = counts.find((c) => c.category === category)?._count._all ?? 0;
    const note = item.categoryNotes.find((n) => n.category === category);
    const required = req[category].required && !note?.notRequired;
    const min = required ? Math.max(1, req[category].min) : 0;
    return { category, count, required, min, satisfied: !required || count >= min, needsReshoot: note?.needsReshoot ?? false, note: note?.note ?? null };
  });
}

export async function setItemCategoryNote(
  user: UserPrincipal,
  itemId: string,
  category: PhotoCategory,
  input: { needsReshoot?: boolean; notRequired?: boolean; note?: string | null },
  lotId?: string | null,
) {
  await getItemOrThrow(user.organizationId, itemId);
  const row = await db.$transaction(async (tx) => {
    const r = await tx.inventoryCategoryNote.upsert({
      where: { inventoryItemId_category: { inventoryItemId: itemId, category } },
      create: { inventoryItemId: itemId, category, needsReshoot: input.needsReshoot ?? false, notRequired: input.notRequired ?? false, note: input.note ?? null },
      update: { needsReshoot: input.needsReshoot, notRequired: input.notRequired, note: input.note },
    });
    if (input.needsReshoot) await changeStatus(tx, user, itemId, "PHOTO", "NEEDS_RESHOOT", { refType: "category", refId: category });
    return r;
  });
  await audit(user, { action: "lot.category_note", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, lotId: lotId ?? null, data: { category, ...input } });
  return row;
}

/** Resolves an id that may be an inventory item or a catalog lot (capture links, agent, legacy outbox). */
export async function resolveItemTarget(orgId: string, id: string, tx: Tx = db): Promise<{ itemId: string; lot: { id: string; catalogId: string } | null } | null> {
  const lot = await tx.lot.findFirst({ where: { id, organizationId: orgId }, select: { id: true, catalogId: true, inventoryItemId: true } });
  if (lot) return { itemId: lot.inventoryItemId, lot: { id: lot.id, catalogId: lot.catalogId } };
  const item = await tx.inventoryItem.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
  return item ? { itemId: item.id, lot: null } : null;
}

export function principalUserId(p: Principal): string | null {
  return p.kind === "user" ? p.userId : null;
}
