import "server-only";
import { asJson } from "../json";
import { z } from "zod";
import { DEFAULT_REQUIREMENTS, PHOTO_CATEGORIES, type CategoryRequirements, type PhotoCategory } from "@avot/shared";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { requirementsSchema } from "./catalogs";
import { changeStatus } from "./item-status";
import { assignToCatalog, syncItemCommercial } from "./assignments";
import { createItemTx, findItemByOpId, itemProgress, setItemCategoryNote, type CategoryProgress } from "./inventory";

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
  /** request key (see createItem): a retried quick-add returns the lot it already created */
  opId: z.string().uuid().optional(),
});
export type LotInput = z.input<typeof lotInputSchema>;

export const lotPatchSchema = lotInputSchema.partial().extend({
  status: z.enum(["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "COMPLETED", "NEEDS_RESHOOT"]).optional(),
});

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
      { title: input.title, subtitle: input.subtitle, author: input.author, printYear: input.printYear, printPlace: input.printPlace, internalNotes: input.internalNotes, opId: input.opId },
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
        requirements: asJson(requirements),
        assignedById: user.userId,
      },
    });
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
  if (input.lotNumber && input.lotNumber !== lot.lotNumber) {
    const clash = await db.lot.findUnique({ where: { catalogId_lotNumber: { catalogId: lot.catalogId, lotNumber: input.lotNumber } } });
    if (clash) throw new AppError("CONFLICT", `פריט מספר ${input.lotNumber} כבר קיים בקטלוג (${clash.title})`);
  }
  const { status, requirements, ...fields } = input;
  const previousStatus = (await db.inventoryItem.findUniqueOrThrow({ where: { id: lot.inventoryItemId }, select: { photoStatus: true } })).photoStatus;
  const updated = await db.$transaction(async (tx) => {
    // photography status and requirements belong to the book
    if (status) await changeStatus(tx, user, lot.inventoryItemId, "PHOTO", status, { refType: "lot", refId: lotId });
    if (requirements) await tx.inventoryItem.update({ where: { id: lot.inventoryItemId }, data: { requirements: asJson(requirements) } });
    const u = await tx.lot.update({ where: { id: lotId }, data: { ...fields, ...(requirements ? { requirements: asJson(requirements) } : {}) } });
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
    data: { ...input, previousStatus: status ? previousStatus : undefined } as object,
  });
  return updated;
}

/** A second physical copy: a NEW inventory book with the same metadata, as the next lot. Photos are not copied. */
export async function duplicateLot(user: UserPrincipal, lotId: string) {
  const lot = await getLotForUser(user, lotId);
  return createLot(user, lot.catalogId, {
    title: `${lot.title} (עותק)`,
    subtitle: lot.subtitle,
    shortDescription: lot.shortDescription,
    description: lot.description,
    internalNotes: lot.internalNotes,
    author: lot.author,
    printYear: lot.printYear,
    printPlace: lot.printPlace,
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
  const moved = await assignToCatalog(user, lot.inventoryItemId, {
    catalogId: targetCatalogId,
    lotNumber,
    title: lot.title,
    shortDescription: lot.shortDescription,
    description: lot.description,
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
  const picks = await db.pickTask.count({ where: { lotId } });
  if (picks) throw new AppError("CONFLICT", "לפריט קיימות משימות ליקוט");
  await db.$transaction(async (tx) => {
    await tx.lot.delete({ where: { id: lotId } });
    await syncItemCommercial(tx, user, lot.inventoryItemId, { reason: `השיוך לקטלוג ${lot.catalog.number} נמחק` });
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
      item: { deletionRequestedAt: null },
      ...(opts.status && opts.status !== "ALL" ? { status: opts.status as never } : {}),
      ...(opts.assignment === "active" ? { assignmentStatus: "ACTIVE" as const } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { subtitle: { contains: q, mode: "insensitive" } },
              { author: { contains: q, mode: "insensitive" } },
              { item: { inventoryNumber: { contains: q.toUpperCase() } } },
              ...(asNumber !== undefined ? [{ lotNumber: asNumber }] : []),
            ],
          }
        : {}),
    },
    include: { item: { select: { inventoryNumber: true, primaryAssetId: true, physicalStatus: true, currentLocation: { select: { code: true } } } } },
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
  const itemIds = [...new Set(lots.map((l) => l.inventoryItemId))];
  const counts = await db.photoAsset.groupBy({
    by: ["inventoryItemId", "category"],
    where: { inventoryItemId: { in: itemIds }, deletedAt: null },
    _count: { _all: true },
  });
  const firstThumbs = await db.photoAsset.findMany({
    where: { inventoryItemId: { in: lots.filter((l) => !l.primaryAssetId && !l.item.primaryAssetId).map((l) => l.inventoryItemId) }, deletedAt: null, thumbKey: { not: null } },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    distinct: ["inventoryItemId"],
    select: { id: true, inventoryItemId: true },
  });
  return lots.map(({ item, ...l }) => {
    const byCat = Object.fromEntries(
      PHOTO_CATEGORIES.map((c) => [c, counts.find((x) => x.inventoryItemId === l.inventoryItemId && x.category === c)?._count._all ?? 0]),
    ) as Record<PhotoCategory, number>;
    return {
      ...l,
      inventoryNumber: item.inventoryNumber,
      physicalStatus: item.physicalStatus,
      locationCode: item.currentLocation?.code ?? null,
      counts: byCat,
      thumbAssetId: l.primaryAssetId ?? item.primaryAssetId ?? firstThumbs.find((t) => t.inventoryItemId === l.inventoryItemId)?.id ?? null,
    };
  });
}
