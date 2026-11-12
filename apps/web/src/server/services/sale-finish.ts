import "server-only";
import { z } from "zod";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { asJson } from "../json";
import { addMoney } from "@/lib/money";
import { endLotTx, syncItemCommercial } from "./assignments";
import { memberItemIds } from "./lot-members";
import { createPickTaskTx } from "./picking";

/*
 * "סיום מכירה": the AUCTION is over. It is not the end of payments and shipments (those go on, also after the catalog is archived).
 * A lot with no result is never turned into "unsold" on its own: a person decides, with the numbers in front of them.
 */

export type Disposition = "HOLD_POST_SALE" | "RELEASE_TO_STOCK" | "RETURN_TO_CONSIGNOR" | "LEAVE";

export async function finishSalePreview(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const lots = await db.lot.findMany({
    where: { catalogId, mergedIntoLotId: null },
    select: { id: true, lotNumber: true, title: true, commercialStatus: true, assignmentStatus: true, unsoldDisposition: true, members: { where: { removedAt: null }, select: { inventoryItemId: true } } },
    orderBy: { lotNumber: "asc" },
  });
  const purchases = await db.purchase.findMany({ where: { catalogId, status: "ACTIVE" }, select: { customerId: true, hammerPrice: true, lotId: true, customer: { select: { needsDetails: true } } } });
  const soldLotIds = new Set(purchases.map((p) => p.lotId).filter((x): x is string => !!x));
  const live = lots.filter((l) => l.assignmentStatus === "ACTIVE" || soldLotIds.has(l.id));
  const unsold = live.filter((l) => l.commercialStatus === "UNSOLD" && l.assignmentStatus === "ACTIVE");
  // no result: still waiting in the sale (not sold, not marked unsold) - and sold lots whose buyer was never recorded
  const unknown = live.filter((l) => l.assignmentStatus === "ACTIVE" && (l.commercialStatus === "ASSIGNED" || l.commercialStatus === "OFFERED"));
  const soldNoBuyer = lots.filter((l) => l.commercialStatus === "SOLD" && !soldLotIds.has(l.id));
  const needsDetails = new Set(purchases.filter((p) => p.customer?.needsDetails).map((p) => p.customerId));
  return {
    catalog: { id: catalog.id, number: catalog.number, name: catalog.name, finishedAt: catalog.saleFinishedAt?.toISOString() ?? null, archived: catalog.status === "ARCHIVED" },
    totalLots: live.length,
    soldLots: soldLotIds.size,
    soldBooks: lots.filter((l) => soldLotIds.has(l.id)).reduce((a, l) => a + Math.max(1, l.members.length), 0),
    unsoldLots: unsold.length,
    unknownLots: unknown.length,
    unknownList: unknown.slice(0, 50).map((l) => ({ id: l.id, lotNumber: l.lotNumber, title: l.title })),
    hammerTotal: addMoney(...purchases.map((p) => p.hammerPrice?.toFixed(2))),
    buyers: new Set(purchases.map((p) => p.customerId)).size,
    purchases: purchases.length,
    /** lots that still need a person: no result, a sale without a buyer, a buyer with missing details */
    needAttention: unknown.length + soldNoBuyer.length + needsDetails.size,
    soldWithoutBuyer: soldNoBuyer.length,
    buyersNeedingDetails: needsDetails.size,
    unsoldUndecided: unsold.filter((l) => l.unsoldDisposition === "NONE").length,
  };
}

export const finishSaleSchema = z.object({
  /** what happens to the unsold lots that no override names */
  unsold: z.enum(["HOLD_POST_SALE", "RELEASE_TO_STOCK", "RETURN_TO_CONSIGNOR", "LEAVE"]).default("LEAVE"),
  /** per lot decisions */
  overrides: z.record(z.string().uuid(), z.enum(["HOLD_POST_SALE", "RELEASE_TO_STOCK", "RETURN_TO_CONSIGNOR", "LEAVE"])).default({}),
  /** lots with no result stay as they are unless the person explicitly says to mark them unsold (and writes why) */
  markUnknownUnsold: z.boolean().default(false),
  reason: z.string().trim().max(300).nullish(),
});

async function applyDisposition(tx: Tx, user: UserPrincipal, lotId: string, d: Exclude<Disposition, "LEAVE">, catalogNumber: string) {
  const lot = await tx.lot.findUniqueOrThrow({ where: { id: lotId } });
  if (lot.commercialStatus !== "UNSOLD" || lot.assignmentStatus !== "ACTIVE") return false;
  if (d === "HOLD_POST_SALE") {
    // still bound to the catalog and available for a deal after the auction
    await tx.lot.update({ where: { id: lotId }, data: { unsoldDisposition: "HOLD_POST_SALE" } });
  } else if (d === "RELEASE_TO_STOCK") {
    // the assignment ends; the book, its photos, details, result and starting price stay; it can go into a new catalog
    await endLotTx(tx, user, lotId, "UNSOLD", `לא נמכר, שוחרר למלאי (קטלוג ${catalogNumber})`);
    await tx.lot.update({ where: { id: lotId }, data: { unsoldDisposition: "RELEASED_TO_STOCK" } });
  } else {
    // back to the consignor: an exit task per book (picked, handed over and recorded like any other removal); NOT a sale
    const itemIds = await memberItemIds(lotId, tx);
    const first = await tx.inventoryItem.findFirst({ where: { id: { in: itemIds } }, select: { consignor: { select: { name: true } } } });
    await endLotTx(tx, user, lotId, "UNSOLD", `לא נמכר, הוחזר למפקיד (קטלוג ${catalogNumber})`);
    await tx.lot.update({ where: { id: lotId }, data: { unsoldDisposition: "RETURN_TO_CONSIGNOR" } });
    for (const itemId of itemIds) await createPickTaskTx(tx, user, itemId, { lotId, reason: `החזרה למפקיד${first?.consignor?.name ? `: ${first.consignor.name}` : ""}`, note: "הוחזר למפקיד, לא נמכר" });
  }
  await tx.saleEvent.create({ data: { organizationId: user.organizationId, catalogId: lot.catalogId, kind: `UNSOLD_${d}`, data: asJson({ lotId, lotNumber: lot.lotNumber, startingPrice: lot.startingPrice?.toFixed(2) ?? null }), userId: user.userId } });
  return true;
}

export async function finishSale(user: UserPrincipal, catalogId: string, raw: z.input<typeof finishSaleSchema>) {
  const input = finishSaleSchema.parse(raw);
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  if (input.markUnknownUnsold && !input.reason?.trim()) throw new AppError("VALIDATION", "סימון לוטים ללא תוצאה כ'לא נמכר' מחייב לציין סיבה");
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${catalogId}::uuid FOR UPDATE`;
      const cat = await tx.catalog.findUniqueOrThrow({ where: { id: catalogId } });
      let markedUnsold = 0;
      if (input.markUnknownUnsold) {
        const unknown = await tx.lot.findMany({ where: { catalogId, mergedIntoLotId: null, assignmentStatus: "ACTIVE", commercialStatus: { in: ["ASSIGNED", "OFFERED"] } } });
        for (const l of unknown) {
          await tx.lot.update({ where: { id: l.id }, data: { commercialStatus: "UNSOLD" } });
          for (const itemId of await memberItemIds(l.id, tx)) await syncItemCommercial(tx, user, itemId, { reason: input.reason ?? "ללא תוצאה", refId: l.id });
          markedUnsold += 1;
        }
        if (markedUnsold) await tx.saleEvent.create({ data: { organizationId: user.organizationId, catalogId, kind: "UNKNOWN_MARKED_UNSOLD", data: asJson({ lots: markedUnsold, reason: input.reason }), userId: user.userId } });
      }
      const unsold = await tx.lot.findMany({ where: { catalogId, mergedIntoLotId: null, assignmentStatus: "ACTIVE", commercialStatus: "UNSOLD" }, select: { id: true } });
      const applied: Record<string, number> = {};
      for (const l of unsold) {
        const d = (input.overrides[l.id] ?? input.unsold) as Disposition;
        if (d === "LEAVE") continue;
        if (await applyDisposition(tx, user, l.id, d, cat.number)) applied[d] = (applied[d] ?? 0) + 1;
      }
      const left = await tx.lot.count({ where: { catalogId, mergedIntoLotId: null, assignmentStatus: "ACTIVE", commercialStatus: { in: ["ASSIGNED", "OFFERED"] } } });
      const first = !cat.saleFinishedAt;
      await tx.catalog.update({ where: { id: catalogId }, data: { saleFinishedAt: cat.saleFinishedAt ?? new Date(), saleFinishedById: cat.saleFinishedById ?? user.userId } });
      await tx.saleEvent.create({ data: { organizationId: user.organizationId, catalogId, kind: first ? "SALE_FINISHED" : "SALE_FINISH_UPDATED", data: asJson({ applied, markedUnsold, lotsWithoutResult: left }), userId: user.userId } });
      await audit(user, { action: "sale.finished", entityType: "catalog", entityId: catalogId, data: asJson({ number: cat.number, applied, markedUnsold, lotsWithoutResult: left }) }, tx);
      return { applied, markedUnsold, lotsWithoutResult: left, firstTime: first };
    },
    { timeout: 120_000 },
  );
}

/**
 * Archiving hides the catalog from the active list. It does not touch purchases, payments or shipments, which keep
 * working. Only a catalog whose sale was finished can be archived, and lots still waiting for a result block it.
 */
export async function archiveCatalog(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  if (!catalog.saleFinishedAt) throw new AppError("CONFLICT", "יש לסיים את המכירה לפני העברת הקטלוג לארכיון");
  const left = await db.lot.count({ where: { catalogId, mergedIntoLotId: null, assignmentStatus: "ACTIVE", commercialStatus: { in: ["ASSIGNED", "OFFERED"] } } });
  if (left) throw new AppError("CONFLICT", `ל-${left} לוטים אין עדיין תוצאה. יש לקבוע להם תוצאה או לסמן אותם במפורש כלא נמכרו`, { code: "LOTS_WITHOUT_RESULT", count: left });
  await db.catalog.update({ where: { id: catalogId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
  await audit(user, { action: "catalog.closed", entityType: "catalog", entityId: catalogId, data: { number: catalog.number } });
  return { archived: true };
}
