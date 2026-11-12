import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { parseUsd } from "@/lib/money";

/*
 * The starting price (USD) belongs to the catalog LOT, never to the book in stock. null = not set (never 0).
 * Every change writes a LotPriceEvent (who, when, from what to what); the events outlive the lot's sale, the book's
 * move to another catalog and the lot's merge / dissolution. Concurrent edits are detected with Lot.priceVersion.
 */

export const priceInputSchema = z.object({
  /** "150", "$1,250.50" or null/"" to clear */
  price: z.union([z.string(), z.number(), z.null()]),
  /** the version the editor saw: when someone saved a different value since, the save is refused with the current value */
  expectedVersion: z.number().int().min(0).optional(),
  note: z.string().trim().max(300).nullish(),
});

export const money = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : d.toFixed(2));

export type PriceChangeKind = "SET" | "CHANGE" | "CLEAR" | "MERGED_INTO" | "MERGED_FROM" | "DISSOLVED" | "ENDED" | "DELETED";

export async function recordPriceEvent(
  tx: Tx,
  principal: Principal,
  lot: { id: string; organizationId: string; catalogId: string; lotNumber: number },
  kind: PriceChangeKind,
  previous: Prisma.Decimal | string | null,
  next: Prisma.Decimal | string | null,
  extra: { note?: string | null; data?: Prisma.InputJsonValue } = {},
) {
  await tx.lotPriceEvent.create({
    data: {
      organizationId: lot.organizationId,
      lotId: lot.id,
      catalogId: lot.catalogId,
      lotNumber: lot.lotNumber,
      kind,
      previous: previous === null ? null : new Prisma.Decimal(previous),
      next: next === null ? null : new Prisma.Decimal(next),
      note: extra.note ?? null,
      data: extra.data,
      userId: principal.kind === "user" ? principal.userId : null,
    },
  });
}

/** Sets, changes or clears the starting price of one lot. Returns the lot's price state. */
export async function setStartingPrice(user: UserPrincipal, lotId: string, raw: z.input<typeof priceInputSchema>) {
  const input = priceInputSchema.parse(raw);
  let price: string | null;
  try {
    price = parseUsd(input.price);
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }
  const head = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!head) throw notFound("הפריט");
  assertHouse(user, head.catalog.auctionHouseId);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lotId}::uuid FOR UPDATE`;
    const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });
    if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר - מחיר הפתיחה נקבע בלוט המשולב");
    if (lot.assignmentStatus === "ENDED") throw new AppError("CONFLICT", "השיוך הזה הסתיים - מחיר הפתיחה ההיסטורי נשמר ואינו ניתן לשינוי");
    const before = money(lot.startingPrice);
    if (input.expectedVersion !== undefined && input.expectedVersion !== lot.priceVersion && before !== price) {
      const last = await tx.lotPriceEvent.findFirst({ where: { lotId }, orderBy: { createdAt: "desc" } });
      const who = last?.userId ? ((await tx.user.findUnique({ where: { id: last.userId }, select: { name: true } }))?.name ?? null) : null;
      throw new AppError("CONFLICT", `מישהו אחר עדכן את מחיר הפתיחה בינתיים${who ? ` (${who})` : ""}. המחיר הנוכחי: ${before ? `$${before}` : "לא הוגדר"}`, {
        code: "PRICE_CONFLICT",
        current: before,
        version: lot.priceVersion,
        changedBy: who,
      });
    }
    if (before === price) return { lotId, startingPrice: before, priceVersion: lot.priceVersion, changed: false };
    const updated = await tx.lot.update({ where: { id: lotId }, data: { startingPrice: price === null ? null : new Prisma.Decimal(price), priceVersion: { increment: 1 } } });
    const kind: PriceChangeKind = price === null ? "CLEAR" : before === null ? "SET" : "CHANGE";
    await recordPriceEvent(tx, user, lot, kind, before, price, { note: input.note ?? null });
    await audit(user, { action: "lot.price_set", entityType: "lot", entityId: lotId, lotId, inventoryItemId: lot.inventoryItemId, data: { from: before, to: price, kind } }, tx);
    return { lotId, startingPrice: money(updated.startingPrice), priceVersion: updated.priceVersion, changed: true };
  });
}

/** The lot's price history, newest first, with names. */
export async function lotPriceHistory(user: UserPrincipal, lotId: string) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  const events = await db.lotPriceEvent.findMany({ where: { lotId }, orderBy: { createdAt: "desc" }, take: 200 });
  const users = await db.user.findMany({ where: { id: { in: events.map((e) => e.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return events.map((e) => ({
    id: e.id,
    kind: e.kind,
    previous: money(e.previous),
    next: money(e.next),
    note: e.note,
    by: e.userId ? (names.get(e.userId) ?? null) : null,
    at: e.createdAt.toISOString(),
  }));
}

/**
 * Earlier prices of a book from OTHER catalogs/assignments, to inform (never to copy): shown when a book is assigned to a
 * new catalog so the person can decide. Newest first.
 */
export async function previousPricesOfBook(user: UserPrincipal, itemId: string) {
  const members = await db.lotMember.findMany({ where: { inventoryItemId: itemId, organizationId: user.organizationId }, select: { lotId: true } });
  const lots = await db.lot.findMany({
    where: { id: { in: members.map((m) => m.lotId) }, startingPrice: { not: null } },
    select: { id: true, lotNumber: true, startingPrice: true, commercialStatus: true, assignmentStatus: true, catalog: { select: { number: true, name: true, auctionHouse: { select: { name: true } } } } },
    orderBy: { assignedAt: "desc" },
    take: 10,
  });
  return lots.map((l) => ({ lotId: l.id, lotNumber: l.lotNumber, price: money(l.startingPrice)!, house: l.catalog.auctionHouse.name, catalogNumber: l.catalog.number, catalogName: l.catalog.name, outcome: l.commercialStatus, active: l.assignmentStatus === "ACTIVE" }));
}

/** The catalog's price control: "200 לוטים · 180 עם מחיר · 20 ללא מחיר" — counts the active, visible lots (a merged lot is one). */
export async function catalogPriceSummary(catalogId: string) {
  const where = { catalogId, assignmentStatus: "ACTIVE" as const, mergedIntoLotId: null };
  const [total, withPrice] = await Promise.all([db.lot.count({ where }), db.lot.count({ where: { ...where, startingPrice: { not: null } } })]);
  return { total, withPrice, withoutPrice: total - withPrice };
}
