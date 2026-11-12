import "server-only";
import { z } from "zod";
import { Prisma, type InventoryItem } from "@prisma/client";
import { BOOK_SIZES, DEFAULT_REQUIREMENTS, ITEM_REVIEW_STATUSES, ITEM_TYPES, PHOTO_CATEGORIES, classifyCode, formatInventoryNumber, type CategoryRequirements, type PhotoCategory } from "@avot/shared";
import { db, type Tx } from "../db";
import { asJson } from "../json";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { canSeeHouse } from "../auth/houses";
import { changeStatus } from "./item-status";
import { locationLabel, locationInclude } from "./location-label";
import { requireConsignor } from "./consignors";
import { changedMaterialFields, reviewAfterHumanEdit } from "./item-review";
import { normalizeQuery, searchTokens } from "@/lib/search-text";
import { ITEM_FORMAT_FIELDS, formatToStore, itemTextFormatSchema, readTextFormat, type TextFormat } from "@/lib/rich-text";

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const optionalMm = z.number().int().min(1).max(5000).nullish();

export const itemInputSchema = z.object({
  title: z.string().trim().min(1, "שם הספר נדרש").max(300),
  subtitle: optionalText(300),
  author: optionalText(200),
  printPlace: optionalText(200),
  printYear: optionalText(50),
  publisher: optionalText(200),
  itemType: z.enum(ITEM_TYPES).optional(),
  edition: optionalText(200),
  extent: optionalText(200),
  bibliographicNotes: optionalText(5000),
  internalNotes: optionalText(5000),
  conditionNotes: optionalText(2000),
  /** bold / underline / color of the three long texts; null removes all formatting. Kept only while it spells the stored text */
  textFormat: itemTextFormatSchema.nullish(),
  /** the catalog draft kept on the item (see schema.prisma); a person's edit marks it MANUAL */
  catalogHeadline: optionalText(500),
  catalogDescription: optionalText(20000),
  heightMm: optionalMm,
  widthMm: optionalMm,
  depthMm: optionalMm,
  sizeCategory: z.enum(BOOK_SIZES).optional(),
  /** external tag already on the box / sleeve; default = the inventory number */
  barcode: z.string().trim().min(3).max(64).regex(/^[\x21-\x7e]+$/, "ברקוד: תווי ASCII בלבד").optional(),
  /**
   * The depositor. Mandatory for a NEW book: `requireConsignor` (called by createItemTx, the one place a book is
   * inserted) refuses a missing, foreign or archived consignor with a clear message. Optional in the schema only so
   * that message is ours and not a generic validation error; on an edit it may change but never be cleared.
   */
  consignorId: z.string().uuid("מזהה מפקיד לא תקין").optional(),
  /** client-generated key of this create request: a double Enter / retried request returns the same book */
  opId: z.string().uuid().optional(),
});
export type ItemInput = z.input<typeof itemInputSchema>;
export const itemPatchSchema = itemInputSchema.omit({ opId: true }).partial();

/** Bibliographic fields copied to a lot when the book is assigned to a catalog. */
export const LOT_COPY_FIELDS = ["title", "subtitle", "author", "printYear", "printPlace"] as const;

/** Allocates the next inventory serial atomically. Never reused, gaps are fine. */
export async function allocateSerial(tx: Tx, orgId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ seq: bigint }[]>`
    UPDATE "Organization" SET "inventorySerialSeq" = "inventorySerialSeq" + 1 WHERE id = ${orgId}::uuid RETURNING "inventorySerialSeq" AS seq`;
  return BigInt(rows[0]!.seq);
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
  const consignorId = await requireConsignor(tx, principal.organizationId, input.consignorId);
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
      consignorId,
      title: input.title,
      subtitle: input.subtitle ?? null,
      author: input.author ?? null,
      printPlace: input.printPlace ?? null,
      printYear: input.printYear ?? null,
      publisher: input.publisher ?? null,
      itemType: input.itemType ?? "UNKNOWN",
      edition: input.edition ?? null,
      extent: input.extent ?? null,
      bibliographicNotes: input.bibliographicNotes ?? null,
      internalNotes: input.internalNotes ?? null,
      conditionNotes: input.conditionNotes ?? null,
      catalogHeadline: input.catalogHeadline ?? null,
      catalogDescription: input.catalogDescription ?? null,
      catalogDescriptionSource: input.catalogHeadline || input.catalogDescription ? "MANUAL" : null,
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
    { action: "inventory.created", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { inventoryNumber, title: item.title, consignorId } },
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
 *
 * Every change of the details raises detailsVersion. With `expectedVersion` (autosave of the review panel) the
 * save is refused with 409 when the details changed since the client loaded them (an AI result, another user):
 * nothing newer is overwritten silently. A material change withdraws an approval (see item-review.ts).
 */
/** The textFormat column after an edit: a field keeps its formatting only while it spells the stored text. */
function nextItemTextFormat(
  item: { textFormat: unknown } & Record<(typeof ITEM_FORMAT_FIELDS)[number], string | null>,
  given: z.infer<typeof itemTextFormatSchema> | null | undefined,
  fields: Partial<Record<(typeof ITEM_FORMAT_FIELDS)[number], string | null>>,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  const out: TextFormat = readTextFormat(item.textFormat, ITEM_FORMAT_FIELDS);
  let touched = false;
  for (const k of ITEM_FORMAT_FIELDS) {
    const text = fields[k] !== undefined ? fields[k]! : item[k];
    if (given === null) {
      if (out[k]) touched = true;
      delete out[k];
    } else if (given && given[k] !== undefined) {
      const stored = formatToStore(given[k], text ?? null);
      if (stored) out[k] = stored;
      else delete out[k];
      touched = true;
    } else if (out[k] && fields[k] !== undefined && fields[k] !== item[k]) {
      delete out[k];
      touched = true;
    }
  }
  if (!touched) return undefined;
  return Object.keys(out).length ? asJson(out) : Prisma.DbNull;
}

export async function updateItem(user: UserPrincipal, id: string, input: z.infer<typeof itemPatchSchema>, opts: {
  expectedVersion?: number;
  /** how the values came: typed by a person, or an AI addition the person applied */
  source?: "manual" | "ai";
  /** runs inside the same transaction as the update, after it (a background job closes its run there: all or nothing) */
  inTx?: (tx: Tx, updated: InventoryItem) => Promise<void>;
} = {}) {
  const item = await getItemOrThrow(user.organizationId, id);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== item.detailsVersion) {
    throw new AppError("CONFLICT", "פרטי הפריט עודכנו בינתיים (ניתוח AI או משתמש אחר). השינויים שלך לא נשמרו כדי לא לדרוס אותם.", { detailsVersion: item.detailsVersion, code: "STALE_DETAILS" });
  }
  if (input.barcode && input.barcode !== item.barcode) {
    const clash = await db.inventoryItem.findFirst({
      where: { organizationId: user.organizationId, id: { not: id }, OR: [{ barcode: input.barcode }, { inventoryNumber: input.barcode }] },
      select: { inventoryNumber: true },
    });
    if (clash) throw new AppError("CONFLICT", `הברקוד ${input.barcode} כבר משויך לספר ${clash.inventoryNumber}`);
  }
  // a consignor change is validated like a new assignment (same organization, not archived) and logged with names
  let consignorChange: { from: string | null; to: string } | null = null;
  if (input.consignorId && input.consignorId !== item.consignorId) {
    await requireConsignor(db, user.organizationId, input.consignorId);
    const names = await db.consignor.findMany({ where: { id: { in: [input.consignorId, ...(item.consignorId ? [item.consignorId] : [])] } }, select: { id: true, name: true } });
    consignorChange = { from: names.find((n) => n.id === item.consignorId)?.name ?? null, to: names.find((n) => n.id === input.consignorId)!.name };
  }
  const sizeCategory =
    input.sizeCategory ??
    (input.heightMm !== undefined || input.widthMm !== undefined
      ? item.sizeCategory === "UNKNOWN" || item.sizeCategory === sizeFromDimensions(item.heightMm, item.widthMm)
        ? sizeFromDimensions(input.heightMm === undefined ? item.heightMm : input.heightMm, input.widthMm === undefined ? item.widthMm : input.widthMm)
        : undefined
      : undefined);
  const { textFormat: givenFormat, ...fields } = input;
  const material = changedMaterialFields(item, fields);
  const format = nextItemTextFormat(item, givenFormat, fields);
  const catalogEdited = (input.catalogHeadline !== undefined || input.catalogDescription !== undefined) && material.some((f) => f === "catalogHeadline" || f === "catalogDescription");
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${id}::uuid FOR UPDATE`;
    if (opts.expectedVersion !== undefined) {
      const now = await tx.inventoryItem.findUniqueOrThrow({ where: { id }, select: { detailsVersion: true } });
      if (now.detailsVersion !== opts.expectedVersion) {
        throw new AppError("CONFLICT", "פרטי הפריט עודכנו בינתיים (ניתוח AI או משתמש אחר). השינויים שלך לא נשמרו כדי לא לדרוס אותם.", { detailsVersion: now.detailsVersion, code: "STALE_DETAILS" });
      }
    }
    const u = await tx.inventoryItem.update({
      where: { id },
      data: {
        ...fields,
        ...(format !== undefined ? { textFormat: format } : {}),
        ...(sizeCategory ? { sizeCategory } : {}),
        ...(material.length ? { detailsVersion: { increment: 1 } } : {}),
        ...(catalogEdited ? { catalogDescriptionSource: "MANUAL" as const } : {}),
      },
    });
    if (opts.inTx) await opts.inTx(tx, u);
    const review = await reviewAfterHumanEdit(tx, user, item, material);
    if (review) Object.assign(u, await tx.inventoryItem.findUniqueOrThrow({ where: { id }, select: { reviewStatus: true, reviewChangedAt: true, reviewChangedById: true, approvedAt: true, approvedById: true } }));
    // the lot the book is a member of (ordinary or combined)
    const activeMember = await tx.lotMember.findFirst({ where: { inventoryItemId: id, isActive: true, removedAt: null }, include: { lot: true } });
    const active = activeMember?.lot ?? null;
    const lotBooks = active ? await tx.lotMember.count({ where: { lotId: active.id, removedAt: null } }) : 0;
    if (input.consignorId && input.consignorId !== item.consignorId && lotBooks > 1) {
      throw new AppError("CONFLICT", `הספר נמצא בלוט משולב (פריט ${active!.lotNumber}) וכל הספרים בלוט משולב חייבים להשתייך לאותו מפקיד. פרקו את הלוט או הסירו את הספר ממנו לפני שינוי המפקיד.`);
    }
    // an ordinary lot follows the book's details; a combined lot has its own shared title and text (never copied from one book)
    if (active && lotBooks <= 1) {
      const lotPatch: Record<string, string | null> = {};
      for (const f of LOT_COPY_FIELDS) {
        if (input[f] !== undefined && active[f] === item[f]) lotPatch[f] = input[f] ?? (f === "title" ? item.title : null);
      }
      if (Object.keys(lotPatch).length) await tx.lot.update({ where: { id: active.id }, data: lotPatch });
    }
    return u;
  });
  const { consignorId: _consignorId, textFormat: _format, ...textFields } = input;
  // the formatting segments are not logged (they repeat the text); only the fact that formatting was saved
  const otherFields = { ...textFields, ...(givenFormat !== undefined ? { textFormat: givenFormat === null ? null : true } : {}) };
  if (Object.keys(otherFields).length) await audit(user, { action: "inventory.updated", entityType: "inventory", entityId: id, inventoryItemId: id, data: { ...otherFields, via: opts.source ?? "manual" } as object });
  if (consignorChange) {
    await audit(user, { action: "inventory.consignor_changed", entityType: "inventory", entityId: id, inventoryItemId: id, data: { consignorId: input.consignorId!, ...consignorChange } });
  }
  return updated;
}

export async function setItemPhotoStatus(user: UserPrincipal, id: string, status: z.infer<typeof photoStatusSchema>) {
  await getItemOrThrow(user.organizationId, id);
  const changed = await db.$transaction((tx) => changeStatus(tx, user, id, "PHOTO", status, { refType: "manual" }));
  if (changed) await audit(user, { action: "inventory.photo_status", entityType: "inventory", entityId: id, inventoryItemId: id, data: { status } });
}
export const photoStatusSchema = z.enum(["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"]);

/* ───────────────────────── listing ───────────────────────── */

export const INVENTORY_VIEWS = ["all", "needs_review", "no_catalog", "no_photos", "no_location", "no_consignor", "missing", "awaiting_pick", "unsold"] as const;
export type InventoryView = (typeof INVENTORY_VIEWS)[number];

export interface InventoryListOptions {
  q?: string;
  view?: InventoryView;
  houseId?: string;
  /** only this consignor's books */
  consignorId?: string;
  /** books that were sold are not part of the active stock: the default list hides them (they are in "נמכרו" until they leave, and after) */
  includeSold?: boolean;
  /** hide books that already hold an ACTIVE assignment in this catalog (the "add from inventory" picker) */
  notInCatalogId?: string;
  photoStatus?: string;
  physicalStatus?: string;
  /** "מצב פרטי הפריט" */
  reviewStatus?: string;
  /** the list's filter panel: several values inside one group match ANY of them, different groups must ALL match */
  filters?: InventoryFilters;
  sort?: "updated" | "number" | "title";
  page?: number;
  pageSize?: number;
}

export interface InventoryFilters {
  photoStatuses?: string[];
  reviewStatuses?: string[];
  aiStatuses?: string[];
  commercialStatuses?: string[];
  physicalStatuses?: string[];
  itemTypes?: string[];
  houseIds?: string[];
  catalogIds?: string[];
  /** true = in an active catalog / lot, false = in none */
  assigned?: boolean;
  warehouseIds?: string[];
  /** "עמודה" (a zone of a warehouse) */
  zoneIds?: string[];
  /** no storage location at all */
  noLocation?: boolean;
  consignorIds?: string[];
  /** true = has photos, false = none */
  hasPhotos?: boolean;
  author?: string;
  printPlace?: string;
  printYear?: string;
  addedFrom?: Date;
  addedTo?: Date;
  serialFrom?: number;
  serialTo?: number;
}

/** One search word against the fields people actually look a book up by (not every column: this runs on every keystroke). */
function tokenMatch(tok: string): Prisma.InventoryItemWhereInput {
  const asDigits = /^\d+$/.test(tok);
  const or: Prisma.InventoryItemWhereInput[] = [
    { title: { contains: tok, mode: "insensitive" } },
    { subtitle: { contains: tok, mode: "insensitive" } },
    { author: { contains: tok, mode: "insensitive" } },
    { publisher: { contains: tok, mode: "insensitive" } },
    { printPlace: { contains: tok, mode: "insensitive" } },
    { printYear: { contains: tok, mode: "insensitive" } },
    { consignor: { name: { contains: tok, mode: "insensitive" } } },
    // the lot / catalog the book sits in now
    {
      lotMemberships: {
        some: {
          isActive: true,
          removedAt: null,
          lot: { OR: [{ title: { contains: tok, mode: "insensitive" } }, { catalog: { OR: [{ name: { contains: tok, mode: "insensitive" } }, { number: { contains: tok, mode: "insensitive" } }] } }, ...(asDigits && tok.length <= 6 ? [{ lotNumber: Number(tok) }] : [])] },
        },
      },
    },
  ];
  if (tok.length >= 3) or.push({ inventoryNumber: { contains: tok.toUpperCase() } });
  if (tok.length >= 4) or.push({ barcode: { contains: tok, mode: "insensitive" } });
  if (asDigits && tok.length <= 7) or.push({ serial: BigInt(tok) });
  return { OR: or };
}

export function inventoryWhere(orgId: string, o: InventoryListOptions): Prisma.InventoryItemWhereInput {
  // books waiting for their permanent deletion are out of everyday work
  const and: Prisma.InventoryItemWhereInput[] = [{ organizationId: orgId, deletionRequestedAt: null }];
  // commercial stock only: a sold book leaves this list at once (it stays in the warehouse until it ships). The physical views
  // (missing, waiting for pick, no location) show what is really in the house, sold or not.
  if (!o.includeSold && o.view !== "missing" && o.view !== "awaiting_pick" && o.view !== "no_location") and.push({ commercialStatus: { not: "SOLD" } });
  const q = normalizeQuery(o.q);
  if (q) {
    const code = classifyCode(q);
    // "35" finds 10000035 (short numbers are sequence numbers); long digit strings match the number / barcode
    const serial = /^\d{1,7}$/.test(q) ? BigInt(q) : undefined;
    const words = searchTokens(q);
    and.push({
      OR: [
        // a scanned or typed code, exactly
        ...(code.type === "ITEM" ? [{ inventoryNumber: code.value }, { aliases: { some: { alias: code.value } } }] : []),
        { barcode: q },
        { aliases: { some: { alias: q.toUpperCase() } } },
        ...(/^\d{3,}$/.test(q) ? [{ inventoryNumber: { contains: q } }] : []),
        ...(serial !== undefined ? [{ serial }] : []),
        // words, in any order: every word has to match something in the row
        { AND: words.map(tokenMatch) },
      ],
    });
  }
  switch (o.view) {
    case "needs_review":
      // "דורשים בדיקה אנושית"
      and.push({ reviewStatus: { in: ["PENDING_REVIEW", "IN_REVIEW"] } });
      break;
    case "no_catalog":
      and.push({ lotMemberships: { none: { isActive: true, removedAt: null } }, physicalStatus: { not: "SHIPPED" }, commercialStatus: { not: "SOLD" } });
      break;
    case "no_photos":
      and.push({ photoCount: 0 });
      break;
    case "no_location":
      and.push({ currentLocationId: null, physicalStatus: { notIn: ["SHIPPED", "PACKED", "PICKED"] } });
      break;
    case "no_consignor":
      and.push({ consignorId: null });
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
  if (o.notInCatalogId) and.push({ lotMemberships: { none: { isActive: true, removedAt: null, lot: { catalogId: o.notInCatalogId } } } });
  if (o.consignorId) and.push({ consignorId: o.consignorId });
  if (o.houseId) and.push({ lotMemberships: { some: { isActive: true, removedAt: null, lot: { catalog: { auctionHouseId: o.houseId } } } } });
  if (o.photoStatus) and.push({ photoStatus: o.photoStatus as never });
  if (o.physicalStatus) and.push({ physicalStatus: o.physicalStatus as never });
  if (o.reviewStatus && (ITEM_REVIEW_STATUSES as readonly string[]).includes(o.reviewStatus)) and.push({ reviewStatus: o.reviewStatus as never });
  if (o.filters) and.push(...filterClauses(o.filters));
  return { AND: and };
}

const activeMembership = { isActive: true, removedAt: null } as const;

function filterClauses(f: InventoryFilters): Prisma.InventoryItemWhereInput[] {
  const and: Prisma.InventoryItemWhereInput[] = [];
  const has = (a?: unknown[]): a is unknown[] => !!a && a.length > 0;
  if (has(f.photoStatuses)) and.push({ photoStatus: { in: f.photoStatuses as never[] } });
  if (has(f.reviewStatuses)) and.push({ reviewStatus: { in: f.reviewStatuses as never[] } });
  if (has(f.aiStatuses)) and.push({ aiStatus: { in: f.aiStatuses as never[] } });
  if (has(f.commercialStatuses)) and.push({ commercialStatus: { in: f.commercialStatuses as never[] } });
  if (has(f.physicalStatuses)) and.push({ physicalStatus: { in: f.physicalStatuses as never[] } });
  if (has(f.itemTypes)) and.push({ itemType: { in: f.itemTypes as never[] } });
  if (has(f.consignorIds)) and.push({ consignorId: { in: f.consignorIds as string[] } });
  if (has(f.houseIds)) and.push({ lotMemberships: { some: { ...activeMembership, lot: { catalog: { auctionHouseId: { in: f.houseIds as string[] } } } } } });
  if (has(f.catalogIds)) and.push({ lotMemberships: { some: { ...activeMembership, lot: { catalogId: { in: f.catalogIds as string[] } } } } });
  if (f.assigned === true) and.push({ lotMemberships: { some: activeMembership } });
  if (f.assigned === false) and.push({ lotMemberships: { none: activeMembership } });
  // places: "no location" is one more value of the same group (a book is in the chosen warehouse / column OR has no location)
  const places: Prisma.InventoryItemWhereInput[] = [];
  if (has(f.warehouseIds)) places.push({ currentLocation: { shelf: { zone: { warehouseId: { in: f.warehouseIds as string[] } } } } });
  if (has(f.zoneIds)) places.push({ currentLocation: { shelf: { zoneId: { in: f.zoneIds as string[] } } } });
  if (f.noLocation) places.push({ currentLocationId: null });
  if (places.length) and.push({ OR: places });
  if (f.hasPhotos === true) and.push({ photoCount: { gt: 0 } });
  if (f.hasPhotos === false) and.push({ photoCount: 0 });
  for (const k of ["author", "printPlace", "printYear"] as const) {
    const v = normalizeQuery(f[k]);
    if (v) and.push({ [k]: { contains: v, mode: "insensitive" } });
  }
  if (f.addedFrom || f.addedTo) and.push({ createdAt: { ...(f.addedFrom ? { gte: f.addedFrom } : {}), ...(f.addedTo ? { lt: f.addedTo } : {}) } });
  if (f.serialFrom !== undefined || f.serialTo !== undefined) and.push({ serial: { ...(f.serialFrom !== undefined ? { gte: BigInt(f.serialFrom) } : {}), ...(f.serialTo !== undefined ? { lte: BigInt(f.serialTo) } : {}) } });
  return and;
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
        consignor: { select: { id: true, name: true } },
        // the lot the book is in now (ordinary or combined)
        lotMemberships: {
          where: { isActive: true, removedAt: null },
          include: { lot: { include: { catalog: { select: { id: true, number: true, name: true, auctionHouse: { select: { id: true, slug: true, name: true, accentColor: true } } } } } } },
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
      const lot = r.lotMemberships[0]?.lot;
      const visible = lot ? canSeeHouse(user, lot.catalog.auctionHouse.id) : false;
      return {
        id: r.id,
        serial: Number(r.serial),
        inventoryNumber: r.inventoryNumber,
        barcode: r.barcode,
        title: r.title,
        author: r.author,
        photoStatus: r.photoStatus,
        physicalStatus: r.physicalStatus,
        commercialStatus: r.commercialStatus,
        reviewStatus: r.reviewStatus,
        aiStatus: r.aiStatus,
        hasAiResult: r.aiCompletedAt !== null,
        aiError: r.aiError,
        photoCount: r.photoCount,
        consignor: r.consignor,
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
  const total = await db.inventoryItem.count({ where: inventoryWhere(orgId, {}) });
  return { all: total, ...Object.fromEntries(views.map((v, i) => [v, counts[i]!])) } as Record<InventoryView, number>;
}

/**
 * The three views of the same books, counted apart (a combined lot is one lot but several books):
 *   active      books still in the commercial stock (not sold)
 *   physical    books that are physically in the house (not shipped, not missing) - sold or not
 *   sold        books that were sold, split by where they are now
 * Lots sold (purchases) are counted separately from the physical books.
 */
export async function inventoryBreakdown(orgId: string) {
  const base = { organizationId: orgId, deletionRequestedAt: null };
  const sold = { ...base, commercialStatus: "SOLD" as const };
  const [active, physical, missing, soldBooks, soldInHouse, soldAwaitingPick, soldPickedPacked, shipped, soldLots, legacyLots] = await Promise.all([
    db.inventoryItem.count({ where: { ...base, commercialStatus: { not: "SOLD" } } }),
    db.inventoryItem.count({ where: { ...base, physicalStatus: { notIn: ["SHIPPED", "MISSING"] } } }),
    db.inventoryItem.count({ where: { ...base, physicalStatus: "MISSING" } }),
    db.inventoryItem.count({ where: sold }),
    db.inventoryItem.count({ where: { ...sold, physicalStatus: { in: ["AWAITING_STORAGE", "IN_STORAGE"] } } }),
    db.inventoryItem.count({ where: { ...sold, physicalStatus: "AWAITING_PICK" } }),
    db.inventoryItem.count({ where: { ...sold, physicalStatus: { in: ["PICKED", "PACKED"] } } }),
    db.inventoryItem.count({ where: { ...base, physicalStatus: "SHIPPED" } }),
    db.purchase.count({ where: { organizationId: orgId, status: "ACTIVE" } }),
    db.purchase.count({ where: { organizationId: orgId, status: "ACTIVE", lotId: null } }),
  ]);
  return {
    /** active stock available for sale */
    active,
    /** physically in the house, including sold books that wait for pick / shipment */
    physical,
    missing,
    /** sold books (physical), and where they are: still on the shelf, waiting for pick, picked / packed, left */
    soldBooks,
    soldInHouse,
    soldAwaitingPick,
    soldPickedPacked,
    shipped,
    /** purchases (a combined lot is one) */
    soldLots,
    legacyLots,
  };
}
export type InventoryBreakdown = Awaited<ReturnType<typeof inventoryBreakdown>>;

/* ───────────────────────── lookup by code ───────────────────────── */

/** Finds a book by its printed tag (inventory number / registered barcode) or a legacy catalog label. */
export async function findItemByCode(orgId: string, raw: string, tx: Tx = db) {
  const code = classifyCode(raw);
  if (code.type === "LOT") {
    const lot = await tx.lot.findFirst({ where: { id: code.value, organizationId: orgId }, select: { id: true, inventoryItemId: true } });
    if (!lot) return null;
    // a combined lot has several books: its label cannot stand for one of them (each book is scanned by its own tag)
    if ((await tx.lotMember.count({ where: { lotId: lot.id, removedAt: null } })) > 1) return null;
    return tx.inventoryItem.findUnique({ where: { id: lot.inventoryItemId } });
  }
  const value = code.type === "ITEM" ? code.value : code.value.trim();
  if (!value) return null;
  // current number, registered external barcode, or a former number kept as an alias (printed "ITM-000035" tags)
  return tx.inventoryItem.findFirst({
    where: { organizationId: orgId, deletionRequestedAt: null, OR: [{ inventoryNumber: value }, { barcode: value }, { aliases: { some: { alias: value.toUpperCase() } } }] },
  });
}

/* ───────────────────────── detail & history ───────────────────────── */

export async function getItemDetail(user: UserPrincipal, id: string) {
  const item = await db.inventoryItem.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      currentLocation: { include: locationInclude },
      consignor: { select: { id: true, name: true, archivedAt: true } },
      categoryNotes: true,
      lotMemberships: {
        orderBy: { lot: { assignedAt: "desc" } },
        include: {
          lot: {
            include: {
              catalog: { select: { id: true, number: true, name: true, status: true, auctionHouse: { select: { id: true, slug: true, name: true, accentColor: true } } } },
              _count: { select: { members: { where: { removedAt: null } } } },
            },
          },
        },
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
    // every lot the book was ever a member of (newest first); a lot merged into another one is history of the same book
    lots: [...new Map(item.lotMemberships.map((m) => [m.lot.id, m.lot])).values()].map(({ _count, ...l }) => ({ ...l, bookCount: _count.members, hidden: !canSeeHouse(user, l.catalog.auctionHouse.id) })),
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
