import "server-only";
import { z } from "zod";
import type { CommercialStatus } from "@avot/shared";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { asJson } from "../json";
import { changeStatus } from "./item-status";
import { getItemOrThrow } from "./inventory";
import { createPickTaskTx } from "./picking";

/*
 * Catalog assignment = a Lot row linking one InventoryItem to one Catalog.
 * The item is never duplicated. By default a book has at most one ACTIVE
 * assignment (also enforced by a partial unique index); ending an assignment
 * keeps the row as history with its commercial outcome.
 */

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const assignSchema = z.object({
  catalogId: z.string().uuid(),
  /** omitted → next free number in the catalog */
  lotNumber: z.number().int().min(1).max(99999).optional(),
  title: optionalText(300),
  shortDescription: optionalText(2000),
  description: optionalText(20000),
  /**
   * The book already has an active assignment: end it (with this outcome) and
   * open the new one. Without it the request is refused with 409.
   */
  replaceActive: z.boolean().optional(),
  endOutcome: z.enum(["UNSOLD", "WITHDRAWN"]).optional(),
});
export type AssignInput = z.input<typeof assignSchema>;

async function nextLotNumber(tx: Tx, catalogId: string) {
  const agg = await tx.lot.aggregate({ where: { catalogId }, _max: { lotNumber: true, sortOrder: true } });
  return { lotNumber: (agg._max.lotNumber ?? 0) + 1, sortOrder: (agg._max.sortOrder ?? 0) + 1 };
}

/** Item commercial status follows its assignments: active lot → its state; else the latest ended lot's outcome; else UNASSIGNED. */
export async function syncItemCommercial(tx: Tx, principal: Principal, itemId: string, ref: { reason?: string; refId?: string } = {}) {
  const active = await tx.lot.findFirst({ where: { inventoryItemId: itemId, assignmentStatus: "ACTIVE" }, select: { commercialStatus: true } });
  const latest = active ?? (await tx.lot.findFirst({ where: { inventoryItemId: itemId }, orderBy: [{ endedAt: "desc" }, { assignedAt: "desc" }], select: { commercialStatus: true } }));
  const to: CommercialStatus = latest?.commercialStatus ?? "UNASSIGNED";
  await changeStatus(tx, principal, itemId, "COMMERCIAL", to, { reason: ref.reason, refType: "lot", refId: ref.refId });
}

async function endLotTx(tx: Tx, principal: Principal, lotId: string, outcome: "SOLD" | "UNSOLD" | "WITHDRAWN", reason: string | null) {
  const lot = await tx.lot.update({
    where: { id: lotId },
    data: { assignmentStatus: "ENDED", commercialStatus: outcome, endedAt: new Date(), endReason: reason },
  });
  await syncItemCommercial(tx, principal, lot.inventoryItemId, { reason: reason ?? undefined, refId: lotId });
  return lot;
}

/** Assign an inventory book to a catalog of an auction house. */
export async function assignToCatalog(user: UserPrincipal, itemId: string, input: AssignInput) {
  const item = await getItemOrThrow(user.organizationId, itemId);
  const catalog = await db.catalog.findFirst({ where: { id: input.catalogId, organizationId: user.organizationId }, include: { auctionHouse: true } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  if (catalog.status === "ARCHIVED") throw new AppError("CONFLICT", "הקטלוג בארכיון — לא ניתן לשייך אליו ספרים");
  if (item.physicalStatus === "SHIPPED" || item.commercialStatus === "SOLD") throw new AppError("CONFLICT", "הספר נמכר — לא ניתן לשייך אותו לקטלוג נוסף");

  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${catalog.id}::uuid FOR UPDATE`;
    const active = await tx.lot.findFirst({
      where: { inventoryItemId: itemId, assignmentStatus: "ACTIVE" },
      include: { catalog: { include: { auctionHouse: true } } },
    });
    if (active) {
      if (active.catalogId === catalog.id) throw new AppError("CONFLICT", `הספר כבר משויך לקטלוג זה (פריט ${active.lotNumber})`);
      if (!input.replaceActive) {
        throw new AppError("CONFLICT", `הספר כבר משויך לקטלוג פעיל: ${active.catalog.auctionHouse.name}, קטלוג ${active.catalog.number}, פריט ${active.lotNumber}`, {
          activeLot: { id: active.id, lotNumber: active.lotNumber, catalogNumber: active.catalog.number, house: active.catalog.auctionHouse.name },
        });
      }
      assertHouse(user, active.catalog.auctionHouseId);
      if (active.commercialStatus === "SOLD") throw new AppError("CONFLICT", "השיוך הקודם מסומן כנמכר");
      await endLotTx(tx, user, active.id, input.endOutcome ?? "WITHDRAWN", `הועבר ל${catalog.auctionHouse.name}, קטלוג ${catalog.number}`);
    }
    const next = await nextLotNumber(tx, catalog.id);
    const lotNumber = input.lotNumber ?? next.lotNumber;
    const clash = await tx.lot.findUnique({ where: { catalogId_lotNumber: { catalogId: catalog.id, lotNumber } }, select: { title: true } });
    if (clash) throw new AppError("CONFLICT", `פריט מספר ${lotNumber} כבר קיים בקטלוג ${catalog.number} (${clash.title})`);
    const lot = await tx.lot.create({
      data: {
        organizationId: user.organizationId,
        catalogId: catalog.id,
        inventoryItemId: itemId,
        lotNumber,
        sortOrder: next.sortOrder,
        title: input.title ?? item.title,
        subtitle: item.subtitle,
        author: item.author,
        printYear: item.printYear,
        printPlace: item.printPlace,
        shortDescription: input.shortDescription ?? null,
        description: input.description ?? null,
        status: item.photoStatus,
        photoCount: item.photoCount,
        requirements: asJson(item.requirements),
        assignedById: user.userId,
      },
    });
    await tx.lotDescriptionVersion.create({
      data: { lotId: lot.id, version: 1, title: lot.title, shortDescription: lot.shortDescription, description: lot.description, createdById: user.userId },
    });
    await syncItemCommercial(tx, user, itemId, { reason: `שויך ל${catalog.auctionHouse.name}, קטלוג ${catalog.number}`, refId: lot.id });
    await audit(
      user,
      {
        action: "lot.assigned",
        entityType: "lot",
        entityId: lot.id,
        lotId: lot.id,
        inventoryItemId: itemId,
        data: { house: catalog.auctionHouse.slug, catalogId: catalog.id, catalogNumber: catalog.number, lotNumber, replaced: active?.id ?? null },
      },
      tx,
    );
    return lot;
  });
  await db.catalog.update({ where: { id: catalog.id }, data: { updatedAt: new Date() } });
  return result;
}

export const commercialSchema = z.object({
  status: z.enum(["ASSIGNED", "OFFERED", "SOLD", "UNSOLD", "WITHDRAWN"]),
  reason: z.string().trim().max(500).nullish(),
});

/**
 * Commercial outcome of one catalog lot. OFFERED / ASSIGNED keep the
 * assignment active; SOLD / UNSOLD / WITHDRAWN end it. SOLD creates a pick task.
 * An ended (unsold) lot can still be marked SOLD — post-sale deals — as long
 * as the book has not been assigned elsewhere since.
 */
export async function setLotCommercialStatus(user: UserPrincipal, lotId: string, input: z.infer<typeof commercialSchema>) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  if (lot.commercialStatus === input.status) return lot;
  const updated = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${lot.inventoryItemId}::uuid FOR UPDATE`;
    if (lot.assignmentStatus === "ENDED") {
      const newer = await tx.lot.findFirst({ where: { inventoryItemId: lot.inventoryItemId, id: { not: lot.id }, assignedAt: { gt: lot.assignedAt } } });
      if (newer) throw new AppError("CONFLICT", "הספר שויך מאז לקטלוג אחר — לא ניתן לשנות שיוך היסטורי");
      if (lot.commercialStatus === "SOLD") throw new AppError("CONFLICT", "הפריט כבר מסומן כנמכר");
      if (input.status === "ASSIGNED" || input.status === "OFFERED") {
        const other = await tx.lot.findFirst({ where: { inventoryItemId: lot.inventoryItemId, assignmentStatus: "ACTIVE" } });
        if (other) throw new AppError("CONFLICT", "לספר יש שיוך פעיל אחר");
      }
    }
    let row;
    if (input.status === "SOLD" || input.status === "UNSOLD" || input.status === "WITHDRAWN") {
      row = await endLotTx(tx, user, lot.id, input.status, input.reason ?? null);
      if (input.status === "SOLD") await createPickTaskTx(tx, user, lot.inventoryItemId, { lotId: lot.id, reason: `נמכר — קטלוג ${lot.catalog.number}, פריט ${lot.lotNumber}` });
    } else {
      row = await tx.lot.update({ where: { id: lot.id }, data: { commercialStatus: input.status, assignmentStatus: "ACTIVE", endedAt: null, endReason: null } });
      await syncItemCommercial(tx, user, lot.inventoryItemId, { refId: lot.id });
    }
    await audit(
      user,
      { action: "lot.commercial_status", entityType: "lot", entityId: lot.id, lotId: lot.id, inventoryItemId: lot.inventoryItemId, data: { from: lot.commercialStatus, to: input.status, reason: input.reason ?? null } },
      tx,
    );
    return row;
  });
  return updated;
}

/**
 * Ends a sale event: every lot still active is marked UNSOLD (lots marked SOLD
 * before stay sold) and the catalog is archived. Books become available for a
 * new catalog with their photos, location and history intact.
 */
export async function closeCatalog(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const active = await db.lot.findMany({ where: { catalogId, assignmentStatus: "ACTIVE" }, select: { id: true } });
  await db.$transaction(
    async (tx) => {
      for (const l of active) await endLotTx(tx, user, l.id, "UNSOLD", `קטלוג ${catalog.number} הסתיים`);
      await tx.catalog.update({ where: { id: catalogId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    },
    { timeout: 60_000 },
  );
  await audit(user, { action: "catalog.closed", entityType: "catalog", entityId: catalogId, data: { number: catalog.number, unsold: active.length } });
  return { unsold: active.length };
}
