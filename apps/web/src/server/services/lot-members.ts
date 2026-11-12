import "server-only";
import { z } from "zod";
import type { LotStatus } from "@avot/shared";
import type { Lot, Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { asJson } from "../json";
import type { Principal, UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { money, recordPriceEvent } from "./lot-pricing";
import { parseUsd } from "@/lib/money";
import { Prisma as PrismaNs } from "@prisma/client";

/*
 * COMBINED LOTS. A lot is a catalog sale unit; its books are the LotMember rows (one for an ordinary lot, two or more
 * for a combined one). Books stay independent inventory items: nothing here copies, merges or re-owns an item, moves a
 * photo, or touches an item's AI analysis. Merging "absorbs" the single-book lots of the selected books into one kept
 * lot: the absorbed lots end (history, number never reused, mergedIntoLotId set) and their books become members of the
 * kept lot. Removing a book (or dissolving) reactivates the absorbed lot of that book, or opens a new one.
 *
 * Every rule below is checked on the server inside one transaction with row locks (catalog, lots, items - always in
 * id order, so two parallel merges can only queue, never deadlock or double-assign a book). The partial unique index on
 * LotMember is the last line of defence against a book in two active lots.
 */

export const DIFFERENT_CONSIGNORS_MESSAGE = "לא ניתן לאחד ספרים ממפקידים שונים. כל הספרים בלוט משולב חייבים להשתייך לאותו מפקיד.";

const OPEN_PICK = ["OPEN", "PICKED", "PACKED"] as const;

/* ───────────────────────── reading ───────────────────────── */

/** Present members of a lot in the lot's order, with the book fields every caller needs. */
export async function lotMembers(lotId: string, tx: Tx | typeof db = db) {
  return tx.lotMember.findMany({
    where: { lotId, removedAt: null },
    orderBy: { sortOrder: "asc" },
    include: {
      item: {
        select: {
          id: true,
          inventoryNumber: true,
          title: true,
          subtitle: true,
          author: true,
          printPlace: true,
          printYear: true,
          consignorId: true,
          primaryAssetId: true,
          photoCount: true,
          photoStatus: true,
          physicalStatus: true,
          commercialStatus: true,
          reviewStatus: true,
          currentLocationId: true,
        },
      },
    },
  });
}

/** Ids of the books of a lot in the lot's order. */
export async function memberItemIds(lotId: string, tx: Tx | typeof db = db): Promise<string[]> {
  const rows = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, orderBy: { sortOrder: "asc" }, select: { inventoryItemId: true } });
  return rows.map((r) => r.inventoryItemId);
}

/** The ACTIVE lot a book is currently a member of (ordinary or combined), or null. */
export async function activeLotOfItem(itemId: string, tx: Tx | typeof db = db): Promise<Lot | null> {
  const m = await tx.lotMember.findFirst({ where: { inventoryItemId: itemId, isActive: true, removedAt: null }, include: { lot: true } });
  return m?.lot ?? null;
}

/** Number of present books per lot. */
export async function memberCounts(lotIds: string[], tx: Tx | typeof db = db): Promise<Map<string, number>> {
  if (!lotIds.length) return new Map();
  const rows = await tx.lotMember.groupBy({ by: ["lotId"], where: { lotId: { in: lotIds }, removedAt: null }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.lotId, r._count._all]));
}

/** Lot ids (any status) in which the book is a present member: the lots its status mirrors are written to. */
export async function lotIdsOfItem(itemId: string, tx: Tx | typeof db = db): Promise<string[]> {
  const rows = await tx.lotMember.findMany({ where: { inventoryItemId: itemId, removedAt: null }, select: { lotId: true } });
  return [...new Set(rows.map((r) => r.lotId))];
}

/* ───────────────────────── mirrors ───────────────────────── */

/** Photography status of a lot of several books: all equal -> that status; any reshoot -> reshoot; all at least waiting for review -> review; none started -> not started; else in progress. */
export function deriveLotPhotoStatus(statuses: LotStatus[]): LotStatus {
  if (!statuses.length) return "NOT_STARTED";
  if (statuses.every((s) => s === statuses[0])) return statuses[0]!;
  if (statuses.includes("NEEDS_RESHOOT")) return "NEEDS_RESHOOT";
  if (statuses.every((s) => s === "COMPLETED" || s === "PENDING_REVIEW")) return "PENDING_REVIEW";
  return "IN_PROGRESS";
}

/** Recomputes the denormalised photo mirrors of a lot (status, photo count, completion) from its present books. */
export async function refreshLotMirror(tx: Tx, lotId: string) {
  const members = await tx.lotMember.findMany({
    where: { lotId, removedAt: null },
    select: { item: { select: { photoStatus: true, photoCount: true, photoCompletedAt: true } } },
  });
  if (!members.length) return;
  const status = deriveLotPhotoStatus(members.map((m) => m.item.photoStatus as LotStatus));
  const photoCount = members.reduce((n, m) => n + m.item.photoCount, 0);
  const completedAt = status === "COMPLETED" ? members.map((m) => m.item.photoCompletedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? new Date() : null;
  await tx.lot.update({ where: { id: lotId }, data: { status, photoCount, completedAt } });
}

/** Mirrors the item's photo status / photo count onto every lot it is a present member of. */
export async function refreshLotsOfItem(tx: Tx, itemId: string) {
  for (const lotId of await lotIdsOfItem(itemId, tx)) await refreshLotMirror(tx, lotId);
}

/* ───────────────────────── membership writes ───────────────────────── */

/** The founding (only) member of a newly created lot. Every code path that creates a Lot row calls this. */
export async function addFounderMember(tx: Tx, lot: Pick<Lot, "id" | "organizationId" | "inventoryItemId" | "assignedById" | "assignmentStatus">) {
  return tx.lotMember.create({
    data: {
      organizationId: lot.organizationId,
      lotId: lot.id,
      inventoryItemId: lot.inventoryItemId,
      sortOrder: 1,
      isActive: lot.assignmentStatus === "ACTIVE",
      addedById: lot.assignedById,
    },
  });
}

/** An ended lot keeps its members (history) but they stop counting as active; reactivation turns them back on. */
export async function setMembersActive(tx: Tx, lotId: string, active: boolean) {
  await tx.lotMember.updateMany({ where: { lotId, removedAt: null }, data: { isActive: active } });
}

async function recordComposition(tx: Tx, principal: Principal, lot: { id: string; organizationId: string }, kind: "MERGE" | "ADD" | "REMOVE" | "DISSOLVE" | "REORDER", itemIds: string[], data: Record<string, unknown>) {
  await tx.lotCompositionEvent.create({
    data: { organizationId: lot.organizationId, lotId: lot.id, kind, itemIds: asJson(itemIds), userId: principal.kind === "user" ? principal.userId : null, data: asJson(data) },
  });
}

/* ───────────────────────── locking & validation ───────────────────────── */

async function lockRows(tx: Tx, catalogId: string, lotIds: string[], itemIds: string[]) {
  await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${catalogId}::uuid FOR UPDATE`;
  if (lotIds.length) await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ANY(${[...lotIds].sort()}::uuid[]) ORDER BY id FOR UPDATE`;
  if (itemIds.length) await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ANY(${[...itemIds].sort()}::uuid[]) ORDER BY id FOR UPDATE`;
}

type ItemForCheck = {
  id: string;
  inventoryNumber: string;
  title: string;
  consignorId: string | null;
  physicalStatus: string;
  commercialStatus: string;
  deletionRequestedAt: Date | null;
};

/** Why a book cannot take part in a combined lot right now (Hebrew), or null. */
function itemBlockReason(i: ItemForCheck, openPicks: Set<string>): string | null {
  const who = `${i.inventoryNumber} (${i.title})`;
  if (i.deletionRequestedAt) return `הספר ${who} נמצא בתהליך מחיקה`;
  if (i.commercialStatus === "SOLD" || i.physicalStatus === "SHIPPED") return `הספר ${who} נמכר או נשלח - לא ניתן לשנות את הרכב הלוט שלו`;
  if (openPicks.has(i.id) || ["AWAITING_PICK", "PICKED", "PACKED"].includes(i.physicalStatus)) return `הספר ${who} נמצא בתהליך ליקוט - לא ניתן לשנות את הרכב הלוט שלו`;
  return null;
}

/** Every book of a combined lot must have a defined consignor. */
function consignorProblem(i: Pick<ItemForCheck, "id" | "inventoryNumber" | "title" | "consignorId">): string | null {
  return i.consignorId ? null : `לספר ${i.inventoryNumber} (${i.title}) לא מוגדר מפקיד. כל הספרים בלוט משולב חייבים מפקיד מוגדר.`;
}

/** Why the composition of this lot cannot change right now (Hebrew), or null. */
function lotBlockReason(lot: Pick<Lot, "lotNumber" | "assignmentStatus" | "commercialStatus" | "mergedIntoLotId">, catalogStatus: string): string | null {
  if (lot.mergedIntoLotId) return `פריט ${lot.lotNumber} כבר אוחד ללוט אחר`;
  if (catalogStatus === "ARCHIVED") return "הקטלוג בארכיון - לא ניתן לשנות את הרכב הלוטים";
  if (lot.assignmentStatus !== "ACTIVE") return `השיוך של פריט ${lot.lotNumber} הסתיים`;
  if (lot.commercialStatus !== "ASSIGNED") return `פריט ${lot.lotNumber} כבר הוצע / נמכר - לא ניתן לשנות את הרכבו`;
  return null;
}

async function openPickItemIds(tx: Tx, itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const rows = await tx.pickTask.findMany({ where: { inventoryItemId: { in: itemIds }, status: { in: [...OPEN_PICK] } }, select: { inventoryItemId: true } });
  return new Set(rows.map((r) => r.inventoryItemId));
}

/** All books must belong to one consignor. */
function assertSameConsignor(items: { consignorId: string | null }[]) {
  const ids = new Set(items.map((i) => i.consignorId));
  if (ids.size > 1) throw new AppError("CONFLICT", DIFFERENT_CONSIGNORS_MESSAGE, { code: "DIFFERENT_CONSIGNORS" });
}

/* ───────────────────────── merge / add ───────────────────────── */

export const mergeSchema = z.object({
  catalogId: z.string().uuid(),
  /** the lots to combine (all in the catalog); two or more */
  lotIds: z.array(z.string().uuid()).min(2, "יש לבחור לפחות שני פריטים").max(200),
  /** the lot number that survives (one of lotIds) */
  keepLotId: z.string().uuid(),
  /** optional shared title set at once (can be edited later) */
  title: z.string().trim().max(300).nullish().transform((v) => v || null),
  /**
   * A combined lot is ONE sale unit with ONE starting price; prices of the books are never added up. When any of the
   * lots has a price the person must decide: a new price here (null = no price), or keepPrice = keep the kept lot's own.
   */
  startingPrice: z.union([z.string(), z.number(), z.null()]).optional(),
  keepPrice: z.boolean().optional(),
});
export type MergeInput = z.input<typeof mergeSchema>;

/**
 * After a merge the catalog's lot numbers close up: the visible lots (everything except lots merged into another lot)
 * become 1..N in their current order, so there are no gaps. Lots that were merged away are history: they move to
 * negative numbers (never shown) so they never collide with a real number. Done in two statements because of the
 * unique (catalog, number) constraint.
 */
export async function compactLotNumbers(tx: Tx, catalogId: string) {
  await tx.$executeRaw`UPDATE "Lot" SET "lotNumber" = "lotNumber" + 100000000 WHERE "catalogId" = ${catalogId}::uuid`;
  await tx.$executeRaw`
    UPDATE "Lot" l SET "lotNumber" = r.n
    FROM (
      SELECT id,
        CASE WHEN "mergedIntoLotId" IS NULL THEN row_number() OVER (PARTITION BY ("mergedIntoLotId" IS NULL) ORDER BY "lotNumber")
             ELSE -row_number() OVER (PARTITION BY ("mergedIntoLotId" IS NULL) ORDER BY "lotNumber") END AS n
      FROM "Lot" WHERE "catalogId" = ${catalogId}::uuid
    ) r WHERE l.id = r.id`;
}

/**
 * Self-healing: a catalog whose visible lot numbers are not exactly 1..N (an old merge, a deleted lot) or that still
 * has merged-away lots on positive numbers is closed up. Cheap check first, then the same compaction under the
 * catalog lock. Archived catalogs are left alone (their numbers are history).
 */
export async function healLotNumbers(catalogId: string) {
  const rows = await db.$queryRaw<{ visible: bigint; maxn: number | null; minn: number | null; merged_positive: bigint }[]>`
    SELECT count(*) FILTER (WHERE "mergedIntoLotId" IS NULL) AS visible,
           max("lotNumber") FILTER (WHERE "mergedIntoLotId" IS NULL) AS maxn,
           min("lotNumber") FILTER (WHERE "mergedIntoLotId" IS NULL) AS minn,
           count(*) FILTER (WHERE "mergedIntoLotId" IS NOT NULL AND "lotNumber" > 0) AS merged_positive
    FROM "Lot" WHERE "catalogId" = ${catalogId}::uuid`;
  const r = rows[0];
  if (!r || (Number(r.visible) === 0 && Number(r.merged_positive) === 0)) return;
  if (Number(r.visible) === Number(r.maxn ?? 0) && r.minn === 1 && Number(r.merged_positive) === 0) return;
  await db.$transaction(async (tx) => {
    const c = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM "Catalog" WHERE id = ${catalogId}::uuid FOR UPDATE`;
    if (!c[0] || c[0].status === "ARCHIVED") return;
    await compactLotNumbers(tx, catalogId);
  });
}

/**
 * Absorbs the single-book `others` lots and the unassigned `newItemIds` books into `keeper` (a lot that exists in the
 * catalog, ordinary or already combined). Caller has locked rows and checked the keeper. Returns the final member ids.
 */
async function absorb(
  tx: Tx,
  user: UserPrincipal,
  keeper: Lot,
  catalog: { id: string; number: string },
  others: Lot[],
  newItemIds: string[],
  kind: "MERGE" | "ADD",
) {
  const keeperMembers = await tx.lotMember.findMany({ where: { lotId: keeper.id, removedAt: null }, orderBy: { sortOrder: "asc" } });
  let order = keeperMembers.length;
  const joined: { itemId: string; fromLot: string | null }[] = [];
  const mergedLots: { id: string; lotNumber: number; itemId: string }[] = [];
  const now = new Date();

  // lots in catalog order: the books of a merge keep the order of their lot numbers
  const sorted = [...others].sort((a, b) => a.lotNumber - b.lotNumber);
  for (const l of sorted) {
    const members = await tx.lotMember.findMany({ where: { lotId: l.id, removedAt: null } });
    await tx.lot.update({
      where: { id: l.id },
      data: { assignmentStatus: "ENDED", commercialStatus: "WITHDRAWN", endedAt: now, endReason: `אוחד ללוט ${keeper.lotNumber}`, mergedIntoLotId: keeper.id },
    });
    await tx.lotMember.updateMany({ where: { lotId: l.id, removedAt: null }, data: { isActive: false, removedAt: now, removedById: user.userId, removalReason: "MERGED" } });
    for (const m of members) {
      order += 1;
      await tx.lotMember.create({ data: { organizationId: keeper.organizationId, lotId: keeper.id, inventoryItemId: m.inventoryItemId, sortOrder: order, originLotId: l.id, isActive: true, addedById: user.userId } });
      joined.push({ itemId: m.inventoryItemId, fromLot: l.id });
      mergedLots.push({ id: l.id, lotNumber: l.lotNumber, itemId: m.inventoryItemId });
    }
  }
  for (const itemId of newItemIds) {
    order += 1;
    await tx.lotMember.create({ data: { organizationId: keeper.organizationId, lotId: keeper.id, inventoryItemId: itemId, sortOrder: order, originLotId: null, isActive: true, addedById: user.userId } });
    joined.push({ itemId, fromLot: null });
  }

  const hasText = !!(keeper.shortDescription?.trim() || keeper.description?.trim());
  await tx.lot.update({
    where: { id: keeper.id },
    data: { compositionVersion: { increment: 1 }, ...(hasText ? { descriptionNeedsUpdate: true } : {}) },
  });
  await refreshLotMirror(tx, keeper.id);

  if (kind === "MERGE") {
    // the books of a merge keep the order of the lot numbers they came from (the kept lot's own book included)
    const all = await tx.lotMember.findMany({ where: { lotId: keeper.id, removedAt: null }, select: { id: true, originLotId: true } });
    const numberOf = new Map<string, number>([[keeper.id, keeper.lotNumber], ...others.map((l) => [l.id, l.lotNumber] as [string, number])]);
    const sortedAll = [...all].sort((a, b) => (numberOf.get(a.originLotId ?? keeper.id) ?? 0) - (numberOf.get(b.originLotId ?? keeper.id) ?? 0));
    for (const [i, m] of sortedAll.entries()) await tx.lotMember.update({ where: { id: m.id }, data: { sortOrder: i + 1 } });
    const first = await tx.lotMember.findFirst({ where: { lotId: keeper.id, removedAt: null }, orderBy: { sortOrder: "asc" } });
    // the anchor of a lot is its first book
    if (first && first.inventoryItemId !== keeper.inventoryItemId) await tx.lot.update({ where: { id: keeper.id }, data: { inventoryItemId: first.inventoryItemId } });
  }

  const ids = joined.map((j) => j.itemId);
  await recordComposition(tx, user, keeper, kind, ids, {
    keptLotNumber: keeper.lotNumber,
    mergedLots,
    addedUnassigned: newItemIds,
    // what the kept lot looked like before: restored by "פירוק הלוט", and the combined text stays in the version history
    before: { title: keeper.title, subtitle: keeper.subtitle, shortDescription: keeper.shortDescription, description: keeper.description, author: keeper.author, printYear: keeper.printYear, printPlace: keeper.printPlace, primaryAssetId: keeper.primaryAssetId },
  });
  await audit(
    user,
    { action: kind === "MERGE" ? "lot.merged" : "lot.books_added", entityType: "lot", entityId: keeper.id, lotId: keeper.id, data: asJson({ catalogNumber: catalog.number, lotNumber: keeper.lotNumber, itemIds: ids, mergedLots }) },
    tx,
  );
  for (const j of joined) {
    await audit(user, { action: "lot.joined", entityType: "lot", entityId: keeper.id, lotId: keeper.id, inventoryItemId: j.itemId, data: asJson({ lotNumber: keeper.lotNumber, fromLotId: j.fromLot }) }, tx);
    // the book's commercial status follows its (now combined) active lot
    await syncCommercialOfItem(tx, user, j.itemId, keeper.id);
  }
  return memberItemIds(keeper.id, tx);
}

async function syncCommercialOfItem(tx: Tx, user: Principal, itemId: string, lotId: string) {
  // imported lazily: assignments.ts imports this module
  const { syncItemCommercial } = await import("./assignments");
  await syncItemCommercial(tx, user, itemId, { reason: "שויך ללוט משולב", refId: lotId });
}

async function loadCatalogFor(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  return catalog;
}

/**
 * "איחוד ללוט": combines the selected single-book lots of one catalog into the kept lot. Server-side rules (all
 * inside the transaction): same catalog, same consignor (defined), nothing sold / shipped / offered / being picked,
 * no lot that is already combined, no book in another active lot.
 */
export async function mergeLots(user: UserPrincipal, raw: MergeInput) {
  const input = mergeSchema.parse(raw);
  const lotIds = [...new Set(input.lotIds)];
  if (lotIds.length < 2) throw new AppError("VALIDATION", "יש לבחור לפחות שני פריטים");
  if (!lotIds.includes(input.keepLotId)) throw new AppError("VALIDATION", "מספר הפריט לשימור חייב להיות אחד מהפריטים שנבחרו");
  const catalog = await loadCatalogFor(user, input.catalogId);

  const result = await db.$transaction(
    async (tx) => {
      const preLots = await tx.lot.findMany({ where: { id: { in: lotIds }, organizationId: user.organizationId } });
      if (preLots.length !== lotIds.length) throw notFound("חלק מהפריטים");
      if (preLots.some((l) => l.catalogId !== catalog.id)) throw new AppError("CONFLICT", "לא ניתן לאחד פריטים מקטלוגים שונים. כל הפריטים חייבים להיות באותו קטלוג.");
      const preItems = (await tx.lotMember.findMany({ where: { lotId: { in: lotIds }, removedAt: null }, select: { inventoryItemId: true } })).map((m) => m.inventoryItemId);
      await lockRows(tx, catalog.id, lotIds, preItems);

      // re-read under the locks: this is the state the checks are made on
      const lots = await tx.lot.findMany({ where: { id: { in: lotIds } } });
      const members = await tx.lotMember.findMany({ where: { lotId: { in: lotIds }, removedAt: null }, include: { item: true } });
      for (const l of lots) {
        const why = lotBlockReason(l, catalog.status);
        if (why) throw new AppError("CONFLICT", why);
        if (members.filter((m) => m.lotId === l.id).length !== 1) throw new AppError("CONFLICT", `פריט ${l.lotNumber} כבר משולב מכמה ספרים. להוספת ספרים ללוט משולב השתמשו ב"הוסף ספר ללוט" בדף הלוט.`);
      }
      const items = members.map((m) => m.item);
      // the same book twice in the selection cannot happen (one active lot per book), but a stale selection can
      if (new Set(items.map((i) => i.id)).size !== items.length) throw new AppError("CONFLICT", "אותו ספר מופיע פעמיים בבחירה");
      const picks = await openPickItemIds(tx, items.map((i) => i.id));
      for (const i of items) {
        const why = itemBlockReason(i, picks);
        if (why) throw new AppError("CONFLICT", why);
      }
      for (const i of items) {
        const why = consignorProblem(i);
        if (why) throw new AppError("CONFLICT", why);
      }
      assertSameConsignor(items);

      const keeper = lots.find((l) => l.id === input.keepLotId)!;
      const others = lots.filter((l) => l.id !== keeper.id);
      // price decision (before anything changes): the earlier prices are shown to the person, the new one is theirs to set
      const earlier = [...lots].sort((a, b) => a.lotNumber - b.lotNumber).map((l) => ({ lotId: l.id, lotNumber: l.lotNumber, price: money(l.startingPrice) }));
      let newPrice: string | null | undefined;
      if (input.startingPrice !== undefined) {
        try {
          newPrice = parseUsd(input.startingPrice);
        } catch (e) {
          throw new AppError("VALIDATION", (e as Error).message);
        }
      } else if (!input.keepPrice && earlier.some((p) => p.price)) {
        throw new AppError("CONFLICT", "לחלק מהפריטים יש מחיר פתיחה. לוט משולב נמכר כיחידה אחת: יש לקבוע לו מחיר, או לאשר במפורש את השארת המחיר של הפריט שנשמר.", { code: "PRICE_DECISION_REQUIRED", prices: earlier });
      }
      const finalIds = await absorb(tx, user, keeper, catalog, others, [], "MERGE");
      for (const o of others) {
        if (o.startingPrice) await recordPriceEvent(tx, user, o, "MERGED_INTO", o.startingPrice, null, { note: `אוחד ללוט ${keeper.lotNumber}`, data: { keeperLotId: keeper.id } });
      }
      if (newPrice !== undefined) {
        const was = money(keeper.startingPrice);
        if (was !== newPrice) {
          await tx.lot.update({ where: { id: keeper.id }, data: { startingPrice: newPrice === null ? null : new PrismaNs.Decimal(newPrice), priceVersion: { increment: 1 } } });
        }
        await recordPriceEvent(tx, user, keeper, "MERGED_FROM", was, newPrice, { note: "מחיר הלוט המשולב נקבע באיחוד", data: { earlier } });
      } else if (earlier.some((p) => p.price)) {
        await recordPriceEvent(tx, user, keeper, "MERGED_FROM", keeper.startingPrice, keeper.startingPrice, { note: "הושאר מחיר הפריט שנשמר (אושר במפורש)", data: { earlier } });
      }
      if (input.title) await setSharedTitle(tx, user, keeper.id, input.title);
      await compactLotNumbers(tx, catalog.id);
      const after = await tx.lot.findUniqueOrThrow({ where: { id: keeper.id }, select: { lotNumber: true } });
      return { lotId: keeper.id, lotNumber: after.lotNumber, previousLotNumber: keeper.lotNumber, itemIds: finalIds, absorbed: others.map((l) => l.lotNumber) };
    },
    { timeout: 60_000 },
  );
  await db.catalog.update({ where: { id: catalog.id }, data: { updatedAt: new Date() } });
  return result;
}

/** A manually chosen shared title: written as a new description version (history), like every description change. */
async function setSharedTitle(tx: Tx, user: UserPrincipal, lotId: string, title: string) {
  const u = await tx.lot.update({ where: { id: lotId }, data: { title } });
  const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId }, _max: { version: true } });
  await tx.lotDescriptionVersion.create({ data: { lotId, version: (last._max.version ?? 0) + 1, title: u.title, shortDescription: u.shortDescription, description: u.description, createdById: user.userId } });
}

export const addBooksSchema = z.object({
  /** single-book lots of this catalog to absorb */
  lotIds: z.array(z.string().uuid()).max(50).default([]),
  /** books that have no active catalog assignment (assigned straight into this lot) */
  itemIds: z.array(z.string().uuid()).max(50).default([]),
});

/** Books that may join a lot: same catalog's single-book lots and unassigned books, all of the lot's consignor. */
export async function lotCandidates(user: UserPrincipal, lotId: string, q?: string) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  const members = await lotMembers(lotId);
  const consignorId = members[0]?.item.consignorId ?? null;
  if (!consignorId) return { consignorId: null, lots: [], items: [] };
  const search = q?.trim();
  const textWhere = search
    ? { OR: [{ title: { contains: search, mode: "insensitive" as const } }, { inventoryNumber: { contains: search.toUpperCase() } }, { author: { contains: search, mode: "insensitive" as const } }] }
    : {};
  const itemSelect = { id: true, inventoryNumber: true, title: true, author: true, primaryAssetId: true, photoCount: true, physicalStatus: true, commercialStatus: true } as const;
  const lotRows = await db.lot.findMany({
    where: { catalogId: lot.catalogId, id: { not: lotId }, assignmentStatus: "ACTIVE", commercialStatus: "ASSIGNED", mergedIntoLotId: null, members: { some: { removedAt: null, item: { consignorId, deletionRequestedAt: null, commercialStatus: { not: "SOLD" }, physicalStatus: { notIn: ["SHIPPED", "AWAITING_PICK", "PICKED", "PACKED"] }, ...textWhere } } } },
    orderBy: { lotNumber: "asc" },
    take: 200,
    include: { members: { where: { removedAt: null }, orderBy: { sortOrder: "asc" }, include: { item: { select: itemSelect } } } },
  });
  // only single-book lots can be absorbed here (a combined lot joins through its own page)
  const lots = lotRows.filter((l) => l.members.length === 1).map((l) => ({ lotId: l.id, lotNumber: l.lotNumber, item: l.members[0]!.item }));
  const items = await db.inventoryItem.findMany({
    where: {
      organizationId: user.organizationId,
      consignorId,
      deletionRequestedAt: null,
      commercialStatus: { not: "SOLD" },
      physicalStatus: { notIn: ["SHIPPED", "AWAITING_PICK", "PICKED", "PACKED"] },
      lotMemberships: { none: { isActive: true, removedAt: null } },
      ...textWhere,
    },
    orderBy: { serial: "asc" },
    take: 100,
    select: itemSelect,
  });
  return { consignorId, lots, items };
}

/** "הוסף ספר ללוט": absorbs same-catalog single-book lots and/or assigns unassigned books into an existing lot. */
export async function addBooksToLot(user: UserPrincipal, lotId: string, raw: z.input<typeof addBooksSchema>) {
  const input = addBooksSchema.parse(raw);
  const lotIds = [...new Set(input.lotIds)];
  const itemIds = [...new Set(input.itemIds)];
  if (!lotIds.length && !itemIds.length) throw new AppError("VALIDATION", "לא נבחרו ספרים להוספה");
  const head = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!head) throw notFound("הפריט");
  assertHouse(user, head.catalog.auctionHouseId);

  const result = await db.$transaction(
    async (tx) => {
      const involvedLots = [lotId, ...lotIds];
      const preMembers = await tx.lotMember.findMany({ where: { lotId: { in: involvedLots }, removedAt: null }, select: { inventoryItemId: true } });
      await lockRows(tx, head.catalogId, involvedLots, [...preMembers.map((m) => m.inventoryItemId), ...itemIds]);
      const keeper = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });
      const why = lotBlockReason(keeper, head.catalog.status);
      if (why) throw new AppError("CONFLICT", why);
      const others = lotIds.length ? await tx.lot.findMany({ where: { id: { in: lotIds }, organizationId: user.organizationId } }) : [];
      if (others.length !== lotIds.length) throw notFound("חלק מהפריטים");
      if (others.some((l) => l.catalogId !== keeper.catalogId)) throw new AppError("CONFLICT", "לא ניתן לאחד ספרים מקטלוגים שונים. כל הספרים חייבים להיות באותו קטלוג.");
      for (const l of others) {
        const w = lotBlockReason(l, head.catalog.status);
        if (w) throw new AppError("CONFLICT", w);
        if ((await tx.lotMember.count({ where: { lotId: l.id, removedAt: null } })) !== 1) throw new AppError("CONFLICT", `פריט ${l.lotNumber} כבר משולב מכמה ספרים - לא ניתן לצרף אותו ללוט אחר`);
      }
      const current = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, include: { item: true } });
      const absorbedMembers = others.length ? await tx.lotMember.findMany({ where: { lotId: { in: lotIds }, removedAt: null }, include: { item: true } }) : [];
      const fresh = itemIds.length ? await tx.inventoryItem.findMany({ where: { id: { in: itemIds }, organizationId: user.organizationId } }) : [];
      if (fresh.length !== itemIds.length) throw notFound("חלק מהספרים");
      for (const i of fresh) {
        const active = await tx.lotMember.findFirst({ where: { inventoryItemId: i.id, isActive: true, removedAt: null }, include: { lot: { select: { lotNumber: true } } } });
        if (active) throw new AppError("CONFLICT", `הספר ${i.inventoryNumber} כבר משויך לפריט ${active.lot.lotNumber}. אין לשייך ספר לשני לוטים פעילים.`);
      }
      const all = [...current.map((m) => m.item), ...absorbedMembers.map((m) => m.item), ...fresh];
      const picks = await openPickItemIds(tx, all.map((i) => i.id));
      for (const i of all) {
        const w = itemBlockReason(i, picks);
        if (w) throw new AppError("CONFLICT", w);
      }
      for (const i of all) {
        const w = consignorProblem(i);
        if (w) throw new AppError("CONFLICT", w);
      }
      assertSameConsignor(all);
      const finalIds = await absorb(tx, user, keeper, head.catalog, others, itemIds, "ADD");
      if (others.length) await compactLotNumbers(tx, head.catalogId);
      return { lotId, itemIds: finalIds };
    },
    { timeout: 60_000 },
  );
  await db.catalog.update({ where: { id: head.catalogId }, data: { updatedAt: new Date() } });
  return result;
}

/* ───────────────────────── remove / dissolve / reorder ───────────────────────── */

/** A new ordinary lot for a book that left a combined lot and has no lot of its own to return to. */
async function openLotForItem(tx: Tx, user: UserPrincipal, catalog: { id: string; number: string }, itemId: string, reason: string): Promise<Lot> {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  const agg = await tx.lot.aggregate({ where: { catalogId: catalog.id }, _max: { lotNumber: true, sortOrder: true } });
  const lot = await tx.lot.create({
    data: {
      organizationId: user.organizationId,
      catalogId: catalog.id,
      inventoryItemId: itemId,
      lotNumber: (agg._max.lotNumber ?? 0) + 1,
      sortOrder: (agg._max.sortOrder ?? 0) + 1,
      title: item.title,
      subtitle: item.subtitle,
      author: item.author,
      printYear: item.printYear,
      printPlace: item.printPlace,
      shortDescription: item.catalogHeadline ?? null,
      description: item.catalogDescription ?? null,
      status: item.photoStatus,
      photoCount: item.photoCount,
      requirements: asJson(item.requirements),
      assignedById: user.userId,
    },
  });
  await tx.lotDescriptionVersion.create({
    data: { lotId: lot.id, version: 1, title: lot.title, shortDescription: lot.shortDescription, description: lot.description, source: item.catalogDescriptionSource ?? "MANUAL", createdById: user.userId },
  });
  await addFounderMember(tx, lot);
  await audit(user, { action: "lot.assigned", entityType: "lot", entityId: lot.id, lotId: lot.id, inventoryItemId: itemId, data: asJson({ catalogId: catalog.id, catalogNumber: catalog.number, lotNumber: lot.lotNumber, reason }) }, tx);
  return lot;
}

/** Puts a lot that was absorbed back as an active ordinary lot of its book. */
async function reactivateAbsorbed(tx: Tx, user: UserPrincipal, l: Lot, itemId: string, reason: string) {
  // its old number was given up when the numbers closed up after the merge: it joins the end of the catalog
  const agg = await tx.lot.aggregate({ where: { catalogId: l.catalogId }, _max: { lotNumber: true } });
  await tx.lot.update({
    where: { id: l.id },
    data: { assignmentStatus: "ACTIVE", commercialStatus: "ASSIGNED", endedAt: null, endReason: null, mergedIntoLotId: null, inventoryItemId: itemId, lotNumber: Math.max(agg._max.lotNumber ?? 0, 0) + 1 },
  });
  await tx.lotMember.create({ data: { organizationId: l.organizationId, lotId: l.id, inventoryItemId: itemId, sortOrder: 1, originLotId: null, isActive: true, addedById: user.userId } });
  await refreshLotMirror(tx, l.id);
  await audit(user, { action: "lot.reactivated", entityType: "lot", entityId: l.id, lotId: l.id, inventoryItemId: itemId, data: asJson({ lotNumber: l.lotNumber, reason }) }, tx);
}

/**
 * Where a book that leaves a combined lot goes: back to its own lot when that lot is still waiting (absorbed into this
 * lot and ended), otherwise a new lot with a new number. The lot number of the combined lot is never given away.
 */
/** A lot coming out of a combination starts with NO price; whatever it held is kept in the price history. */
async function clearLeftoverPrice(tx: Tx, user: UserPrincipal, lotId: string, note: string) {
  const l = await tx.lot.findUnique({ where: { id: lotId } });
  if (!l || !l.startingPrice) return;
  await tx.lot.update({ where: { id: lotId }, data: { startingPrice: null, priceVersion: { increment: 1 } } });
  await recordPriceEvent(tx, user, l, "DISSOLVED", l.startingPrice, null, { note });
}

async function placeLeavingBook(tx: Tx, user: UserPrincipal, combined: Lot, catalog: { id: string; number: string }, member: { inventoryItemId: string; originLotId: string | null }, reason: string) {
  const origin = member.originLotId ? await tx.lot.findUnique({ where: { id: member.originLotId } }) : null;
  if (origin && origin.id !== combined.id && origin.mergedIntoLotId === combined.id && origin.assignmentStatus === "ENDED" && origin.catalogId === combined.catalogId) {
    await reactivateAbsorbed(tx, user, origin, member.inventoryItemId, reason);
    return { lotId: origin.id, lotNumber: origin.lotNumber, restored: true };
  }
  const fresh = await openLotForItem(tx, user, catalog, member.inventoryItemId, reason);
  return { lotId: fresh.id, lotNumber: fresh.lotNumber, restored: false };
}

/** Renumbers the present members 1..n in their current order. */
async function compactOrder(tx: Tx, lotId: string) {
  const rows = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true } });
  for (const [i, r] of rows.entries()) await tx.lotMember.update({ where: { id: r.id }, data: { sortOrder: i + 1 } });
}

/** "הסרה מהלוט": the book becomes an ordinary lot of the catalog again (its old number if free, else a new one). */
export async function removeBookFromLot(user: UserPrincipal, lotId: string, itemId: string) {
  const head = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!head) throw notFound("הפריט");
  assertHouse(user, head.catalog.auctionHouseId);

  const result = await db.$transaction(
    async (tx) => {
      const present = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, select: { inventoryItemId: true } });
      await lockRows(tx, head.catalogId, [lotId], present.map((m) => m.inventoryItemId));
      const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });
      const why = lotBlockReason(lot, head.catalog.status);
      if (why) throw new AppError("CONFLICT", `לא ניתן להסיר ספר מהלוט: ${why}`);
      const members = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, orderBy: { sortOrder: "asc" } });
      const member = members.find((m) => m.inventoryItemId === itemId);
      if (!member) throw notFound("הספר בלוט");
      if (members.length < 2) throw new AppError("CONFLICT", "זהו הספר היחיד בלוט. כדי להוציא אותו מהקטלוג יש להסיר את הפריט מהקטלוג.");
      const picks = await openPickItemIds(tx, [itemId]);
      if (picks.size) throw new AppError("CONFLICT", "לספר יש משימת ליקוט פעילה - לא ניתן להסיר אותו מהלוט");

      const now = new Date();
      await tx.lotMember.update({ where: { id: member.id }, data: { isActive: false, removedAt: now, removedById: user.userId, removalReason: "REMOVED" } });
      // the lot keeps its number; a lot's anchor is always a present book
      const rest = members.filter((m) => m.id !== member.id);
      if (lot.inventoryItemId === itemId) await tx.lot.update({ where: { id: lotId }, data: { inventoryItemId: rest[0]!.inventoryItemId } });
      await compactOrder(tx, lotId);
      // presentation that referred to the removed book's photos
      const assetIds = (await tx.photoAsset.findMany({ where: { inventoryItemId: itemId }, select: { id: true } })).map((a) => a.id);
      if (assetIds.length) await tx.lotDisplayAsset.deleteMany({ where: { lotId, assetId: { in: assetIds } } });
      const primaryGone = lot.primaryAssetId && assetIds.includes(lot.primaryAssetId);
      const hasText = !!(lot.shortDescription?.trim() || lot.description?.trim());
      await tx.lot.update({ where: { id: lotId }, data: { compositionVersion: { increment: 1 }, ...(hasText ? { descriptionNeedsUpdate: true } : {}), ...(primaryGone ? { primaryAssetId: null } : {}) } });
      await refreshLotMirror(tx, lotId);

      const placed = await placeLeavingBook(tx, user, lot, head.catalog, member, `הוסר מלוט ${lot.lotNumber}`);
      await clearLeftoverPrice(tx, user, placed.lotId, "אין חלוקה אוטומטית של מחיר הלוט המשולב");
      const { syncItemCommercial } = await import("./assignments");
      await syncItemCommercial(tx, user, itemId, { reason: `הוסר מלוט משולב ${lot.lotNumber}`, refId: placed.lotId });
      await recordComposition(tx, user, lot, "REMOVE", [itemId], { restoredLotId: placed.lotId, restoredLotNumber: placed.lotNumber, restoredOwnLot: placed.restored });
      await audit(user, { action: "lot.book_removed", entityType: "lot", entityId: lotId, lotId, inventoryItemId: itemId, data: asJson({ lotNumber: lot.lotNumber, newLotId: placed.lotId, newLotNumber: placed.lotNumber }) }, tx);
      return { lotId, removedItemId: itemId, newLot: placed, remaining: rest.length };
    },
    { timeout: 60_000 },
  );
  await db.catalog.update({ where: { id: head.catalogId }, data: { updatedAt: new Date() } });
  return result;
}

/** "פירוק הלוט": every book returns to a separate lot of the same catalog; the combination's history stays. */
export async function dissolveLot(user: UserPrincipal, lotId: string) {
  const head = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!head) throw notFound("הפריט");
  assertHouse(user, head.catalog.auctionHouseId);

  const result = await db.$transaction(
    async (tx) => {
      const present = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, select: { inventoryItemId: true } });
      await lockRows(tx, head.catalogId, [lotId], present.map((m) => m.inventoryItemId));
      const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });
      const why = lotBlockReason(lot, head.catalog.status);
      if (why) throw new AppError("CONFLICT", `לא ניתן לפרק את הלוט: ${why}`);
      const members = await tx.lotMember.findMany({ where: { lotId, removedAt: null }, orderBy: { sortOrder: "asc" } });
      if (members.length < 2) throw new AppError("CONFLICT", "זה לא לוט משולב");
      const picks = await openPickItemIds(tx, members.map((m) => m.inventoryItemId));
      if (picks.size) throw new AppError("CONFLICT", "לאחד הספרים יש משימת ליקוט פעילה - לא ניתן לפרק את הלוט");

      const now = new Date();
      // the book that was the lot's own (not absorbed from another lot) keeps this lot number
      const founder = members.find((m) => m.originLotId === null) ?? null;
      const leaving = members.filter((m) => m.id !== founder?.id);
      const events = await tx.lotCompositionEvent.findMany({ where: { lotId, kind: "MERGE" }, orderBy: { createdAt: "desc" }, take: 1 });
      const before = (events[0]?.data as { before?: Record<string, string | null> } | null)?.before ?? null;

      await tx.lotMember.updateMany({ where: { lotId, removedAt: null, id: { in: leaving.map((m) => m.id) } }, data: { isActive: false, removedAt: now, removedById: user.userId, removalReason: "DISSOLVED" } });
      const placements: { itemId: string; lotId: string; lotNumber: number; restored: boolean }[] = [];
      if (founder) {
        if (lot.inventoryItemId !== founder.inventoryItemId) await tx.lot.update({ where: { id: lotId }, data: { inventoryItemId: founder.inventoryItemId } });
      } else {
        // nobody is the lot's own: its number ends here (kept as history), the books go to their own lots
        await tx.lot.update({ where: { id: lotId }, data: { assignmentStatus: "ENDED", commercialStatus: "WITHDRAWN", endedAt: now, endReason: "הלוט המשולב פורק" } });
        await tx.lotMember.updateMany({ where: { lotId, removedAt: null }, data: { isActive: false } });
      }
      for (const m of leaving) {
        const p = await placeLeavingBook(tx, user, lot, head.catalog, m, `פירוק לוט ${lot.lotNumber}`);
        placements.push({ itemId: m.inventoryItemId, ...p });
        await clearLeftoverPrice(tx, user, p.lotId, "מחיר הלוט המשולב אינו מחולק בין הספרים");
        const { syncItemCommercial } = await import("./assignments");
        await syncItemCommercial(tx, user, m.inventoryItemId, { reason: `פירוק הלוט המשולב ${lot.lotNumber}`, refId: p.lotId });
        await audit(user, { action: "lot.book_removed", entityType: "lot", entityId: lotId, lotId, inventoryItemId: m.inventoryItemId, data: asJson({ dissolved: true, lotNumber: lot.lotNumber, newLotId: p.lotId, newLotNumber: p.lotNumber }) }, tx);
      }
      if (founder) {
        const assetIds = (await tx.photoAsset.findMany({ where: { inventoryItemId: { in: leaving.map((m) => m.inventoryItemId) } }, select: { id: true } })).map((a) => a.id);
        if (assetIds.length) await tx.lotDisplayAsset.deleteMany({ where: { lotId, assetId: { in: assetIds } } });
        const restore = before ?? {};
        const u = await tx.lot.update({
          where: { id: lotId },
          data: {
            compositionVersion: { increment: 1 },
            descriptionNeedsUpdate: false,
            aiDescriptionRunId: null,
            ...(before ? { title: restore.title ?? lot.title, subtitle: restore.subtitle ?? null, shortDescription: restore.shortDescription ?? null, description: restore.description ?? null, author: restore.author ?? null, printYear: restore.printYear ?? null, printPlace: restore.printPlace ?? null } : {}),
            primaryAssetId: lot.primaryAssetId && assetIds.includes(lot.primaryAssetId) ? null : lot.primaryAssetId,
          },
        });
        // the lot's text goes back to what the single book had: written as a version, the shared text stays in the history
        const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId }, _max: { version: true } });
        await tx.lotDescriptionVersion.create({ data: { lotId, version: (last._max.version ?? 0) + 1, title: u.title, shortDescription: u.shortDescription, description: u.description, createdById: user.userId } });
        await compactOrder(tx, lotId);
        await refreshLotMirror(tx, lotId);
      }
      // the combined lot's price is not split among the books: the lot that stays loses it (kept in the history), the person sets new prices
      if (founder) await clearLeftoverPrice(tx, user, lotId, "פירוק הלוט המשולב: מחיר הלוט אינו מחולק, יש לקבוע מחיר לכל פריט");
      await recordComposition(tx, user, lot, "DISSOLVE", members.map((m) => m.inventoryItemId), { placements, lotKeptBy: founder?.inventoryItemId ?? null, sharedTitle: lot.title, sharedDescription: lot.description });
      await audit(user, { action: "lot.dissolved", entityType: "lot", entityId: lotId, lotId, data: asJson({ lotNumber: lot.lotNumber, placements }) }, tx);
      return { lotId, keptBy: founder?.inventoryItemId ?? null, placements };
    },
    { timeout: 60_000 },
  );
  await db.catalog.update({ where: { id: head.catalogId }, data: { updatedAt: new Date() } });
  return result;
}

export const reorderMembersSchema = z.object({ orderedItemIds: z.array(z.string().uuid()).min(2).max(200) });

/** Order of the books inside the lot (descriptions and the gallery follow it). */
export async function reorderLotMembers(user: UserPrincipal, lotId: string, orderedItemIds: string[]) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lotId}::uuid FOR UPDATE`;
    const members = await tx.lotMember.findMany({ where: { lotId, removedAt: null } });
    const ids = new Set(members.map((m) => m.inventoryItemId));
    if (orderedItemIds.length !== ids.size || orderedItemIds.some((id) => !ids.has(id))) throw new AppError("CONFLICT", "רשימת הספרים בלוט השתנתה. רעננו ונסו שוב.");
    const byItem = new Map(members.map((m) => [m.inventoryItemId, m.id]));
    for (const [i, itemId] of orderedItemIds.entries()) await tx.lotMember.update({ where: { id: byItem.get(itemId)! }, data: { sortOrder: i + 1 } });
    await recordComposition(tx, user, lot, "REORDER", orderedItemIds, {});
    await audit(user, { action: "lot.books_reordered", entityType: "lot", entityId: lotId, lotId, data: asJson({ orderedItemIds }) }, tx);
  });
}

/* ───────────────────────── composition views ───────────────────────── */

/** The lot with its books, consignor and the "needs update" state of the shared description: what the lot page shows. */
export async function getLotComposition(lotId: string) {
  const members = await lotMembers(lotId);
  const history = await db.lotCompositionEvent.findMany({ where: { lotId }, orderBy: { createdAt: "desc" }, take: 50 });
  const absorbed = await db.lot.findMany({ where: { mergedIntoLotId: lotId }, select: { id: true, lotNumber: true, title: true }, orderBy: { lotNumber: "asc" } });
  return { members, history, absorbed, combined: members.length > 1 };
}

/** A consignor id of the lot's books (all equal by construction), or null. */
export function consignorOfMembers(members: { item: { consignorId: string | null } }[]): string | null {
  return members[0]?.item.consignorId ?? null;
}

/** Marks / clears the "description needs an update" flag. */
export async function setDescriptionNeedsUpdate(tx: Tx | typeof db, lotId: string, value: boolean) {
  await tx.lot.update({ where: { id: lotId }, data: { descriptionNeedsUpdate: value } });
}

export type LotMemberRow = Awaited<ReturnType<typeof lotMembers>>[number];
export type { Prisma };

/** Moves a combined lot to another catalog: the lot ends here (withdrawn) and an equal lot with all the books opens there. */
export async function moveCombinedLot(user: UserPrincipal, lot: Lot, target: { id: string; number: string; status: string }, lotNumber?: number) {
  const created = await db.$transaction(
    async (tx) => {
      const present = await tx.lotMember.findMany({ where: { lotId: lot.id, removedAt: null }, orderBy: { sortOrder: "asc" } });
      await lockRows(tx, target.id, [lot.id], present.map((m) => m.inventoryItemId));
      const fresh = await tx.lot.findUniqueOrThrow({ where: { id: lot.id } });
      const why = lotBlockReason(fresh, "ACTIVE");
      if (why) throw new AppError("CONFLICT", why);
      if (target.status === "ARCHIVED") throw new AppError("CONFLICT", "הקטלוג בארכיון — לא ניתן לשייך אליו ספרים");
      const picks = await openPickItemIds(tx, present.map((m) => m.inventoryItemId));
      if (picks.size) throw new AppError("CONFLICT", "לאחד הספרים יש משימת ליקוט פעילה - לא ניתן להעביר את הלוט");
      const agg = await tx.lot.aggregate({ where: { catalogId: target.id }, _max: { lotNumber: true, sortOrder: true } });
      const number = lotNumber ?? (agg._max.lotNumber ?? 0) + 1;
      const clash = await tx.lot.findUnique({ where: { catalogId_lotNumber: { catalogId: target.id, lotNumber: number } }, select: { title: true } });
      if (clash) throw new AppError("CONFLICT", `פריט מספר ${number} כבר קיים בקטלוג ${target.number} (${clash.title})`);
      const now = new Date();
      await tx.lot.update({ where: { id: lot.id }, data: { assignmentStatus: "ENDED", commercialStatus: "WITHDRAWN", endedAt: now, endReason: `הועבר לקטלוג ${target.number}` } });
      if (fresh.startingPrice) await recordPriceEvent(tx, user, fresh, "ENDED", fresh.startingPrice, null, { note: `הועבר לקטלוג ${target.number}`, data: { outcome: "WITHDRAWN" } });
      await tx.lotMember.updateMany({ where: { lotId: lot.id, removedAt: null }, data: { isActive: false } });
      const created = await tx.lot.create({
        data: {
          organizationId: user.organizationId,
          catalogId: target.id,
          inventoryItemId: present[0]!.inventoryItemId,
          lotNumber: number,
          sortOrder: (agg._max.sortOrder ?? 0) + 1,
          title: fresh.title,
          subtitle: fresh.subtitle,
          shortDescription: fresh.shortDescription,
          description: fresh.description,
          author: fresh.author,
          printYear: fresh.printYear,
          printPlace: fresh.printPlace,
          status: fresh.status,
          photoCount: fresh.photoCount,
          requirements: asJson(fresh.requirements),
          assignedById: user.userId,
          primaryAssetId: fresh.primaryAssetId,
          descriptionNeedsUpdate: fresh.descriptionNeedsUpdate,
          aiDescriptionRunId: fresh.aiDescriptionRunId,
          compositionVersion: fresh.compositionVersion,
        },
      });
      await tx.lotDescriptionVersion.create({ data: { lotId: created.id, version: 1, title: created.title, shortDescription: created.shortDescription, description: created.description, createdById: user.userId } });
      for (const [i, m] of present.entries()) {
        await tx.lotMember.create({ data: { organizationId: user.organizationId, lotId: created.id, inventoryItemId: m.inventoryItemId, sortOrder: i + 1, originLotId: null, isActive: true, addedById: user.userId } });
      }
      // the lot's gallery choices (order / hidden) travel with it
      const display = await tx.lotDisplayAsset.findMany({ where: { lotId: lot.id } });
      if (display.length) await tx.lotDisplayAsset.createMany({ data: display.map((d) => ({ lotId: created.id, assetId: d.assetId, sortOrder: d.sortOrder, hidden: d.hidden })) });
      await recordComposition(tx, user, created, "MERGE", present.map((m) => m.inventoryItemId), { movedFromLotId: lot.id, movedFromCatalogId: lot.catalogId, before: null });
      for (const m of present) {
        const { syncItemCommercial } = await import("./assignments");
        await syncItemCommercial(tx, user, m.inventoryItemId, { reason: `הועבר לקטלוג ${target.number}`, refId: created.id });
        await audit(user, { action: "lot.moved_catalog", entityType: "lot", entityId: created.id, lotId: created.id, inventoryItemId: m.inventoryItemId, data: asJson({ from: lot.catalogId, to: target.id, fromLot: lot.id, lotNumber: created.lotNumber }) }, tx);
      }
      return created;
    },
    { timeout: 60_000 },
  );
  await db.catalog.update({ where: { id: target.id }, data: { updatedAt: new Date() } });
  return created;
}

