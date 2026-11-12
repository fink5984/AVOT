import "server-only";
import { asJson } from "../json";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { DEFAULT_REQUIREMENTS, PHOTO_CATEGORIES, type CategoryRequirements, type ItemReviewStatus, type PhotoCategory } from "@avot/shared";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { requirementsSchema } from "./catalogs";
import { recordPriceEvent } from "./lot-pricing";
import { changeStatus } from "./item-status";
import { assignToCatalog, syncItemCommercial } from "./assignments";
import { createItemTx, findItemByOpId, itemProgress, setItemCategoryNote, type CategoryProgress } from "./inventory";
import { locationInclude, locationLabel } from "./location-label";
import { addFounderMember, compactLotNumbers, memberItemIds, moveCombinedLot } from "./lot-members";
import { LOT_FORMAT_FIELDS, formatToStore, readTextFormat, textFormatSchema, type TextFormat } from "@/lib/rich-text";

/*
 * A Lot is a catalog lot: one inventory book's participation in a catalog.
 * Creating a lot from a catalog screen (quick add, form, CSV) receives a new
 * book into inventory and assigns it in one transaction. Photography status
 * and photos belong to the book; the lot holds the catalog's presentation
 * (title, descriptions, number, order) and its commercial outcome.
 */

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const lotInputSchema = z.object({
  lotNumber: z.number().int().min(1).max(99999).optional(),
  title: z.string().trim().min(1, "שם הספר נדרש").max(300),
  subtitle: optionalText(300),
  shortDescription: optionalText(2000),
  description: optionalText(20000),
  internalNotes: optionalText(5000),
  author: optionalText(200),
  printYear: optionalText(50),
  printPlace: optionalText(200),
  requirements: requirementsSchema.optional(),
  /** bold / underline / color of the descriptions (segments of the same text); null removes a field's formatting */
  textFormat: textFormatSchema.optional(),
  /** the depositor of the new physical book (mandatory; checked by createItemTx) */
  consignorId: z.string().uuid("מזהה מפקיד לא תקין").optional(),
  /** request key (see createItem): a retried quick-add returns the lot it already created */
  opId: z.string().uuid().optional(),
});
export type LotInput = z.input<typeof lotInputSchema>;

// the consignor belongs to the physical book (changed from the inventory screen), never to a catalog lot
export const lotPatchSchema = lotInputSchema.omit({ consignorId: true }).partial().extend({
  status: z.enum(["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"]).optional(),
});

/**
 * The textFormat column after a save: each field given keeps its formatting only when it spells exactly the stored
 * text; a field whose text changed without new formatting loses its old one. Untouched fields keep theirs.
 */
function nextTextFormat(
  current: unknown,
  given: z.infer<typeof textFormatSchema> | undefined,
  texts: { description: string | null },
  changed: { description: boolean },
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  const now = readTextFormat(current);
  const out: TextFormat = { ...now };
  let touched = false;
  for (const k of LOT_FORMAT_FIELDS) {
    if (given && given[k] !== undefined) {
      const s = formatToStore(given[k], texts[k]);
      if (s) out[k] = s;
      else delete out[k];
      touched = true;
    } else if (changed[k] && out[k]) {
      delete out[k];
      touched = true;
    }
  }
  if (!touched) return undefined;
  return Object.keys(out).length ? asJson(out) : Prisma.DbNull;
}

async function nextLotNumber(tx: Tx, catalogId: string) {
  const agg = await tx.lot.aggregate({ where: { catalogId }, _max: { lotNumber: true, sortOrder: true } });
  return { lotNumber: (agg._max.lotNumber ?? 0) + 1, sortOrder: (agg._max.sortOrder ?? 0) + 1 };
}

async function getCatalog(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  return catalog;
}

export async function getLotForUser(user: UserPrincipal, lotId: string) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  return lot;
}

/** New book received into inventory and assigned to this catalog. */
export async function createLot(user: UserPrincipal, catalogId: string, input: LotInput) {
  const catalog = await getCatalog(user, catalogId);
  const lotOfPriorRequest = async () => {
    const prior = await findItemByOpId(user.organizationId, input.opId);
    return prior ? db.lot.findFirst({ where: { inventoryItemId: prior.id, catalogId }, orderBy: { assignedAt: "desc" } }) : null;
  };
  const already = await lotOfPriorRequest();
  if (already) return already;
  if (catalog.status === "ARCHIVED") throw new AppError("CONFLICT", "הקטלוג בארכיון — לא ניתן להוסיף אליו פריטים");
  const requirements = (input.requirements ?? catalog.defaultRequirements ?? DEFAULT_REQUIREMENTS) as CategoryRequirements;
  const lot = await createLotTx(user, catalog, catalogId, input, requirements).catch(async (err) => {
    // an identical request (same opId) finished first: its lot is the answer
    const raced = await lotOfPriorRequest();
    if (raced) return raced;
    throw err;
  });
  await db.catalog.update({ where: { id: catalogId }, data: { updatedAt: new Date() } });
  return lot;
}

async function createLotTx(user: UserPrincipal, catalog: { id: string; number: string }, catalogId: string, input: LotInput, requirements: CategoryRequirements) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${catalogId}::uuid FOR UPDATE`;
    const next = await nextLotNumber(tx, catalogId);
    const lotNumber = input.lotNumber ?? next.lotNumber;
    if (input.lotNumber) {
      const clash = await tx.lot.findUnique({ where: { catalogId_lotNumber: { catalogId, lotNumber } } });
      if (clash) throw new AppError("CONFLICT", `פריט מספר ${lotNumber} כבר קיים בקטלוג`);
    }
    const item = await createItemTx(
      tx,
      user,
      { title: input.title, subtitle: input.subtitle, author: input.author, printYear: input.printYear, printPlace: input.printPlace, internalNotes: input.internalNotes, consignorId: input.consignorId, opId: input.opId },
      { requirements },
    );
    const created = await tx.lot.create({
      data: {
        organizationId: user.organizationId,
        catalogId,
        inventoryItemId: item.id,
        lotNumber,
        sortOrder: next.sortOrder,
        title: input.title,
        subtitle: input.subtitle ?? null,
        shortDescription: input.shortDescription ?? null,
        description: input.description ?? null,
        internalNotes: input.internalNotes ?? null,
        author: input.author ?? null,
        printYear: input.printYear ?? null,
        printPlace: input.printPlace ?? null,
        textFormat: nextTextFormat(null, input.textFormat, { description: input.description ?? null }, { description: false }),
        requirements: asJson(requirements),
        assignedById: user.userId,
      },
    });
    await addFounderMember(tx, created);
    await tx.lotDescriptionVersion.create({
      data: { lotId: created.id, version: 1, title: created.title, shortDescription: created.shortDescription, description: created.description, createdById: user.userId },
    });
    await syncItemCommercial(tx, user, item.id, { reason: `שויך לקטלוג ${catalog.number}`, refId: created.id });
    await audit(
      user,
      { action: "lot.created", entityType: "lot", entityId: created.id, lotId: created.id, inventoryItemId: item.id, data: { lotNumber: created.lotNumber, title: created.title, inventoryNumber: item.inventoryNumber } },
      tx,
    );
    return created;
  });
}

export async function updateLot(user: UserPrincipal, lotId: string, input: z.infer<typeof lotPatchSchema>) {
  const lot = await getLotForUser(user, lotId);
  if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר - יש לערוך את הלוט המשולב");
  if (input.lotNumber && input.lotNumber !== lot.lotNumber) {
    const clash = await db.lot.findUnique({ where: { catalogId_lotNumber: { catalogId: lot.catalogId, lotNumber: input.lotNumber } } });
    if (clash) throw new AppError("CONFLICT", `פריט מספר ${input.lotNumber} כבר קיים בקטלוג (${clash.title})`);
  }
  const { status, requirements, textFormat, ...fields } = input;
  // photography status and requirements belong to the books: a combined lot applies them to every one of its books
  const itemIds = await memberItemIds(lotId);
  const previousStatus = lot.status;
  const updated = await db.$transaction(async (tx) => {
    if (status) for (const itemId of itemIds) await changeStatus(tx, user, itemId, "PHOTO", status, { refType: "lot", refId: lotId });
    if (requirements) await tx.inventoryItem.updateMany({ where: { id: { in: itemIds } }, data: { requirements: asJson(requirements) } });
    // a person wrote the text: it is no longer "an AI text for an older composition"
    const changed = { description: fields.description !== undefined && fields.description !== lot.description };
    const textEdited = changed.description || (fields.shortDescription !== undefined && fields.shortDescription !== lot.shortDescription);
    const format = nextTextFormat(
      lot.textFormat,
      textFormat,
      { description: fields.description !== undefined ? fields.description : lot.description },
      changed,
    );
    const u = await tx.lot.update({
      where: { id: lotId },
      data: {
        ...fields,
        ...(requirements ? { requirements: asJson(requirements) } : {}),
        ...(textEdited ? { descriptionNeedsUpdate: false, aiDescriptionRunId: null } : {}),
        ...(format !== undefined ? { textFormat: format } : {}),
      },
    });
    const describes = (["title", "shortDescription", "description"] as const).some((k) => fields[k] !== undefined && fields[k] !== lot[k]);
    if (describes) {
      const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId }, _max: { version: true } });
      await tx.lotDescriptionVersion.create({
        data: { lotId, version: (last._max.version ?? 0) + 1, title: u.title, shortDescription: u.shortDescription, description: u.description, createdById: user.userId },
      });
    }
    return u;
  });
  await audit(user, {
    action: status && status !== previousStatus ? "lot.status_changed" : "lot.updated",
    entityType: "lot",
    entityId: lotId,
    lotId,
    inventoryItemId: lot.inventoryItemId,
    data: { ...input, textFormat: textFormat ? true : undefined, previousStatus: status ? previousStatus : undefined } as object,
  });
  return updated;
}

/** A second physical copy: a NEW inventory book with the same metadata, as the next lot. Photos are not copied. */
export async function duplicateLot(user: UserPrincipal, lotId: string, consignorId: string | undefined) {
  const lot = await getLotForUser(user, lotId);
  if ((await memberItemIds(lotId)).length > 1) throw new AppError("CONFLICT", "לא ניתן לשכפל לוט משולב - שכפול יוצר עותק פיזי נוסף של ספר אחד");
  // never assumed: the second copy may belong to somebody else, so the caller must name its consignor
  return createLot(user, lot.catalogId, {
    consignorId,
    title: `${lot.title} (עותק)`,
    subtitle: lot.subtitle,
    shortDescription: lot.shortDescription,
    description: lot.description,
    internalNotes: lot.internalNotes,
    author: lot.author,
    printYear: lot.printYear,
    printPlace: lot.printPlace,
    textFormat: readTextFormat(lot.textFormat),
    requirements: lot.requirements as unknown as CategoryRequirements,
  });
}

/**
 * Moves a book to another catalog: the current assignment ends (withdrawn,
 * kept as history) and a new one is opened in the target catalog with the
 * same presentation. The book's photos and location are untouched.
 */
export async function moveLotToCatalog(user: UserPrincipal, lotId: string, targetCatalogId: string, lotNumber?: number) {
  const lot = await getLotForUser(user, lotId);
  await getCatalog(user, targetCatalogId);
  if (lot.catalogId === targetCatalogId) return lot;
  if (lot.assignmentStatus !== "ACTIVE") throw new AppError("CONFLICT", "השיוך הזה כבר הסתיים — שייכו את הספר מחדש ממסך המלאי");
  if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר - יש להעביר את הלוט המשולב");
  const target = await getCatalog(user, targetCatalogId);
  if ((await memberItemIds(lotId)).length > 1) return moveCombinedLot(user, lot, target, lotNumber);
  const moved = await assignToCatalog(user, lot.inventoryItemId, {
    catalogId: targetCatalogId,
    lotNumber,
    title: lot.title,
    shortDescription: lot.shortDescription,
    description: lot.description,
    textFormat: readTextFormat(lot.textFormat),
    replaceActive: true,
    endOutcome: "WITHDRAWN",
  });
  await audit(user, { action: "lot.moved_catalog", entityType: "lot", entityId: moved.id, lotId: moved.id, inventoryItemId: lot.inventoryItemId, data: { from: lot.catalogId, to: targetCatalogId, fromLot: lot.id, lotNumber: moved.lotNumber } });
  return moved;
}

/** Applies a new display order for lots in a catalog (drag & drop / custom sort). */
export async function reorderLots(user: UserPrincipal, catalogId: string, orderedIds: string[]) {
  await getCatalog(user, catalogId);
  const lots = await db.lot.findMany({ where: { catalogId }, select: { id: true } });
  const valid = new Set(lots.map((l) => l.id));
  if (orderedIds.some((id) => !valid.has(id))) throw new AppError("VALIDATION", "רשימת הפריטים אינה תואמת לקטלוג");
  await db.$transaction(orderedIds.map((id, i) => db.lot.update({ where: { id }, data: { sortOrder: i + 1 } })));
  await audit(user, { action: "lot.reordered", entityType: "catalog", entityId: catalogId });
}

/**
 * Removes a catalog assignment entered by mistake. The book, its photos and
 * history stay in inventory. Lots with a commercial outcome (offered, sold …)
 * cannot be deleted — end them instead.
 */
export async function deleteLot(user: UserPrincipal, lotId: string) {
  const lot = await getLotForUser(user, lotId);
  if (lot.commercialStatus !== "ASSIGNED") throw new AppError("CONFLICT", "לפריט יש מצב מסחרי (הוצע / נמכר / לא נמכר) — לא ניתן למחוק, רק לסיים שיוך");
  if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר - נשמר כהיסטוריה ואינו ניתן למחיקה");
  if ((await memberItemIds(lotId)).length > 1) throw new AppError("CONFLICT", "זה לוט משולב - יש לפרק אותו ל\"פירוק הלוט\" לפני הסרתו מהקטלוג");
  const picks = await db.pickTask.count({ where: { lotId } });
  if (picks) throw new AppError("CONFLICT", "לפריט קיימות משימות ליקוט");
  await db.$transaction(async (tx) => {
    // a mistaken assignment disappears, but what its price was stays in the history
    if (lot.startingPrice) await recordPriceEvent(tx, user, lot, "DELETED", lot.startingPrice, null, { note: "השיוך לקטלוג נמחק" });
    await tx.lot.delete({ where: { id: lotId } });
    await syncItemCommercial(tx, user, lot.inventoryItemId, { reason: `השיוך לקטלוג ${lot.catalog.number} נמחק` });
    await compactLotNumbers(tx, lot.catalogId);
  });
  await audit(user, {
    action: "lot.deleted",
    entityType: "lot",
    entityId: lotId,
    inventoryItemId: lot.inventoryItemId,
    data: { lotNumber: lot.lotNumber, title: lot.title, catalogId: lot.catalogId },
  });
}

export async function setCategoryNote(
  user: UserPrincipal,
  lotId: string,
  category: PhotoCategory,
  input: { needsReshoot?: boolean; notRequired?: boolean; note?: string | null },
) {
  const lot = await getLotForUser(user, lotId);
  return setItemCategoryNote(user, lot.inventoryItemId, category, input, lotId);
}

export type { CategoryProgress };

/** Per-category progress of the lot's book. */
export async function lotProgress(lotId: string): Promise<CategoryProgress[]> {
  const lot = await db.lot.findUnique({ where: { id: lotId }, select: { inventoryItemId: true } });
  return lot ? itemProgress(lot.inventoryItemId) : [];
}

export interface LotReview {
  /** one value for the lot: APPROVED only when every book is; otherwise the book that needs a person first */
  status: ItemReviewStatus;
  total: number;
  approved: number;
  inReview: number;
  pending: number;
  notStarted: number;
  /** last person who edited the details of any book of the lot, and when */
  lastEditBy: string | null;
  lastEditAt: string | null;
  /** the approver (single book: its approver; combined lot: the latest approval among its approved books) */
  approvedBy: string | null;
  approvedAt: string | null;
}

/** Aggregates the review state of a lot's books from rows already loaded (no query per lot). */
export function summariseReview(
  books: { reviewStatus: ItemReviewStatus; approvedAt: Date | null; approvedById: string | null; reviewChangedAt: Date | null; reviewChangedById: string | null; lastEdit: { createdAt: Date; userId: string | null } | null }[],
  names: Map<string, string>,
): LotReview {
  const count = (s: ItemReviewStatus) => books.filter((b) => b.reviewStatus === s).length;
  const approved = count("APPROVED");
  const pending = count("PENDING_REVIEW");
  const inReview = count("IN_REVIEW");
  const notStarted = count("NOT_STARTED");
  const status: ItemReviewStatus = approved === books.length ? "APPROVED" : pending ? "PENDING_REVIEW" : inReview ? "IN_REVIEW" : "NOT_STARTED";
  // the latest touch: an edit of the details, or a status change
  const touches = books.flatMap((b) => [b.lastEdit ? { at: b.lastEdit.createdAt, by: b.lastEdit.userId } : null, b.reviewChangedAt ? { at: b.reviewChangedAt, by: b.reviewChangedById } : null]).filter((x): x is { at: Date; by: string | null } => !!x);
  const last = touches.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const approvals = books.filter((b) => b.reviewStatus === "APPROVED" && b.approvedAt).sort((a, b) => b.approvedAt!.getTime() - a.approvedAt!.getTime());
  return {
    status,
    total: books.length,
    approved,
    inReview,
    pending,
    notStarted,
    lastEditBy: last?.by ? (names.get(last.by) ?? null) : null,
    lastEditAt: last?.at.toISOString() ?? null,
    approvedBy: approvals[0]?.approvedById ? (names.get(approvals[0].approvedById) ?? null) : null,
    approvedAt: approvals[0]?.approvedAt?.toISOString() ?? null,
  };
}

export async function listLots(
  user: UserPrincipal,
  catalogId: string,
  opts: { q?: string; status?: string; sort?: string; assignment?: "active" | "all" } = {},
) {
  const q = opts.q?.trim();
  const asNumber = q && /^\d+$/.test(q) ? Number(q) : undefined;
  const lots = await db.lot.findMany({
    where: {
      organizationId: user.organizationId,
      catalogId,
      // a lot that was merged into another one is history, not a row of the catalog
      mergedIntoLotId: null,
      item: { deletionRequestedAt: null },
      ...(opts.status && opts.status !== "ALL" ? { status: opts.status as never } : {}),
      ...(opts.assignment === "active" ? { assignmentStatus: "ACTIVE" as const } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { subtitle: { contains: q, mode: "insensitive" } },
              { author: { contains: q, mode: "insensitive" } },
              {
                members: {
                  some: {
                    removedAt: null,
                    item: { OR: [{ inventoryNumber: { contains: q.toUpperCase() } }, { title: { contains: q, mode: "insensitive" } }, { author: { contains: q, mode: "insensitive" } }] },
                  },
                },
              },
              ...(asNumber !== undefined ? [{ lotNumber: asNumber }] : []),
            ],
          }
        : {}),
    },
    include: {
      item: { select: { inventoryNumber: true, primaryAssetId: true, physicalStatus: true, reviewStatus: true, reviewChangedAt: true, reviewChangedById: true, approvedAt: true, approvedById: true, author: true, printPlace: true, printYear: true, photoCount: true, currentLocation: { include: locationInclude } } },
      members: {
        where: { removedAt: null },
        orderBy: { sortOrder: "asc" },
        select: { inventoryItemId: true, item: { select: { inventoryNumber: true, title: true, reviewStatus: true, reviewChangedAt: true, reviewChangedById: true, approvedAt: true, approvedById: true, author: true, printPlace: true, printYear: true, photoCount: true, primaryAssetId: true, physicalStatus: true, aiStatus: true, aiCompletedAt: true, aiError: true, consignor: { select: { id: true, name: true } }, currentLocation: { include: locationInclude } } } },
      },
    },
    orderBy:
      opts.sort === "title"
        ? { title: "asc" }
        : opts.sort === "updated"
          ? { updatedAt: "desc" }
          : opts.sort === "custom"
            ? { sortOrder: "asc" }
            : { lotNumber: "asc" },
    take: 2000,
  });
  const itemIds = [...new Set(lots.flatMap((l) => (l.members.length ? l.members.map((m) => m.inventoryItemId) : [l.inventoryItemId])))];
  const counts = await db.photoAsset.groupBy({
    by: ["inventoryItemId", "category"],
    where: { inventoryItemId: { in: itemIds }, deletedAt: null },
    _count: { _all: true },
  });
  const firstThumbs = await db.photoAsset.findMany({
    where: { inventoryItemId: { in: itemIds }, deletedAt: null, thumbKey: { not: null } },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    distinct: ["inventoryItemId"],
    select: { id: true, inventoryItemId: true },
  });
  // who last edited a book's details: ONE query for every book of the catalog (newest "inventory.updated" per book), then ONE for names
  const lastEdits = await db.auditLog.findMany({
    where: { inventoryItemId: { in: itemIds }, action: "inventory.updated" },
    orderBy: { createdAt: "desc" },
    distinct: ["inventoryItemId"],
    select: { inventoryItemId: true, createdAt: true, userId: true },
  });
  const nameIds = new Set<string>();
  for (const e of lastEdits) if (e.userId) nameIds.add(e.userId);
  for (const l of lots) for (const it of [l.item, ...l.members.map((m) => m.item)]) for (const id of [it.reviewChangedById, it.approvedById]) if (id) nameIds.add(id);
  const names = new Map((await db.user.findMany({ where: { id: { in: [...nameIds] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const editOf = new Map(lastEdits.map((e) => [e.inventoryItemId, e]));
  return lots.map(({ item, members, ...l }) => {
    const ids = members.length ? members.map((m) => m.inventoryItemId) : [l.inventoryItemId];
    const byCat = Object.fromEntries(
      PHOTO_CATEGORIES.map((c) => [c, counts.filter((x) => ids.includes(x.inventoryItemId) && x.category === c).reduce((n, x) => n + x._count._all, 0)]),
    ) as Record<PhotoCategory, number>;
    const bookItems = members.length ? members.map((m) => ({ id: m.inventoryItemId, it: m.item })) : [{ id: l.inventoryItemId, it: item }];
    const review = summariseReview(bookItems.map(({ id, it }) => ({ ...it, lastEdit: editOf.get(id) ?? null })), names);
    const books = members.map((m) => ({
      itemId: m.inventoryItemId,
      inventoryNumber: m.item.inventoryNumber,
      title: m.item.title,
      physicalStatus: m.item.physicalStatus,
      locationLabel: m.item.currentLocation ? locationLabel(m.item.currentLocation) : null,
      consignorId: m.item.consignor?.id ?? null,
      ai: { aiStatus: m.item.aiStatus, hasAiResult: m.item.aiCompletedAt !== null, aiError: m.item.aiError },
      consignorName: m.item.consignor?.name ?? null,
    }));
    const firstWithPhoto = members.map((m) => m.item.primaryAssetId).find((x): x is string => !!x);
    const statuses = new Set(members.map((m) => m.item.physicalStatus));
    return {
      ...l,
      startingPrice: l.startingPrice === null ? null : l.startingPrice.toFixed(2),
      bookCount: Math.max(1, members.length),
      books,
      review,
      /** identification of the book (or of the first book of a combined lot), straight from the inventory */
      bibliography: { author: bookItems[0]!.it.author, printPlace: bookItems[0]!.it.printPlace, printYear: bookItems[0]!.it.printYear },
      consignorName: books[0]?.consignorName ?? null,
      consignorId: books[0]?.consignorId ?? null,
      inventoryNumber: item.inventoryNumber,
      // one value when all books agree, otherwise the first (the lot page lists every book)
      physicalStatus: statuses.size > 1 ? ("MIXED" as const) : item.physicalStatus,
      locationLabel: members.length > 1 ? null : item.currentLocation ? locationLabel(item.currentLocation) : null,
      counts: byCat,
      thumbAssetId: l.primaryAssetId ?? item.primaryAssetId ?? firstWithPhoto ?? ids.map((id) => firstThumbs.find((t) => t.inventoryItemId === id)?.id).find((x) => !!x) ?? null,
    };
  });
}
