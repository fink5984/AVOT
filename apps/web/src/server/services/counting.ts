import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { changeStatus } from "./item-status";
import { locationInclude, locationLabel } from "./location-label";
import { defaultWarehouse, moveItemTx } from "./warehouse";

/*
 * Stock count: the counter scans a location, then every book in it. Scans are
 * recorded only — no item location changes until a manager reviews the
 * discrepancy report and approves the selected corrections.
 */

export const startCountSchema = z.object({ warehouseId: z.string().uuid().optional(), zoneId: z.string().uuid().nullish(), note: z.string().trim().max(500).nullish() });

export async function startCount(user: UserPrincipal, input: z.infer<typeof startCountSchema>) {
  const wh = input.warehouseId
    ? await db.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: user.organizationId } })
    : await defaultWarehouse(user.organizationId);
  if (!wh) throw notFound("המחסן");
  if (input.zoneId) {
    const z = await db.warehouseZone.findFirst({ where: { id: input.zoneId, warehouseId: wh.id } });
    if (!z) throw notFound("האזור");
  }
  const s = await db.stockCountSession.create({
    data: { organizationId: user.organizationId, warehouseId: wh.id, zoneId: input.zoneId ?? null, note: input.note ?? null, startedById: user.userId },
  });
  await audit(user, { action: "count.started", entityType: "count", entityId: s.id, data: { zoneId: input.zoneId ?? null } });
  return s;
}

export async function listCounts(orgId: string) {
  return db.stockCountSession.findMany({
    where: { organizationId: orgId },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { zone: true, _count: { select: { entries: true, locations: true } } },
  });
}

export interface CountReport {
  session: { id: string; status: string; zone: string | null; startedAt: string; note: string | null };
  visited: { id: string; code: string; label: string; expected: number; found: number }[];
  /** recorded in a counted location but not scanned */
  missing: { itemId: string; inventoryNumber: string; title: string; locationCode: string }[];
  /** scanned in one location, recorded in another */
  wrongLocation: { entryId: string; itemId: string; inventoryNumber: string; title: string; foundCode: string; foundId: string; recordedCode: string }[];
  /** scanned, but the database had no location for it (or marked it missing / shipped) */
  surplus: { entryId: string; itemId: string; inventoryNumber: string; title: string; foundCode: string; foundId: string; physicalStatus: string }[];
  /** locations of the counted zone that were not visited (books there were not checked) */
  notVisited: { code: string; expected: number }[];
  matched: number;
}

export async function countReport(orgId: string, sessionId: string): Promise<CountReport> {
  const session = await db.stockCountSession.findFirst({ where: { id: sessionId, organizationId: orgId }, include: { zone: true, locations: true, entries: true } });
  if (!session) throw notFound("הספירה");
  const visitedIds = session.locations.map((l) => l.locationId);
  const scope = await db.storageLocation.findMany({
    where: {
      organizationId: orgId,
      OR: [{ id: { in: visitedIds } }, session.zoneId ? { shelf: { zoneId: session.zoneId } } : { shelf: { zone: { warehouseId: session.warehouseId } } }],
    },
    include: locationInclude,
  });
  const locById = new Map(scope.map((l) => [l.id, l]));
  const [expectedItems, foundItems] = await Promise.all([
    db.inventoryItem.findMany({
      where: { organizationId: orgId, currentLocationId: { in: scope.map((l) => l.id) } },
      select: { id: true, inventoryNumber: true, title: true, currentLocationId: true },
    }),
    db.inventoryItem.findMany({
      where: { id: { in: session.entries.map((e) => e.inventoryItemId) } },
      select: { id: true, inventoryNumber: true, title: true, currentLocationId: true, physicalStatus: true, currentLocation: { select: { code: true } } },
    }),
  ]);
  const found = new Map(foundItems.map((i) => [i.id, i]));
  const scanned = new Set(session.entries.map((e) => e.inventoryItemId));
  const visited = new Set(visitedIds);

  const report: CountReport = {
    session: { id: session.id, status: session.status, zone: session.zone ? `${session.zone.name}` : null, startedAt: session.startedAt.toISOString(), note: session.note },
    visited: [],
    missing: [],
    wrongLocation: [],
    surplus: [],
    notVisited: [],
    matched: 0,
  };
  for (const l of scope) {
    const expected = expectedItems.filter((i) => i.currentLocationId === l.id).length;
    if (visited.has(l.id)) {
      report.visited.push({ id: l.id, code: l.code, label: locationLabel(l), expected, found: session.entries.filter((e) => e.locationId === l.id).length });
    } else if (expected) report.notVisited.push({ code: l.code, expected });
  }
  for (const i of expectedItems) {
    if (visited.has(i.currentLocationId!) && !scanned.has(i.id)) report.missing.push({ itemId: i.id, inventoryNumber: i.inventoryNumber, title: i.title, locationCode: locById.get(i.currentLocationId!)!.code });
  }
  for (const e of session.entries) {
    const i = found.get(e.inventoryItemId);
    if (!i) continue;
    const foundCode = locById.get(e.locationId)?.code ?? "?";
    if (i.currentLocationId === e.locationId && i.physicalStatus !== "MISSING") report.matched++;
    else if (!i.currentLocationId || i.physicalStatus === "MISSING" || i.physicalStatus === "SHIPPED")
      report.surplus.push({ entryId: e.id, itemId: i.id, inventoryNumber: i.inventoryNumber, title: i.title, foundCode, foundId: e.locationId, physicalStatus: i.physicalStatus });
    else report.wrongLocation.push({ entryId: e.id, itemId: i.id, inventoryNumber: i.inventoryNumber, title: i.title, foundCode, foundId: e.locationId, recordedCode: i.currentLocation?.code ?? "—" });
  }
  report.visited.sort((a, b) => a.code.localeCompare(b.code));
  return report;
}

export async function submitCount(user: UserPrincipal, sessionId: string) {
  const s = await db.stockCountSession.findFirst({ where: { id: sessionId, organizationId: user.organizationId } });
  if (!s) throw notFound("הספירה");
  if (s.status !== "OPEN") throw new AppError("CONFLICT", "הספירה כבר הוגשה");
  await db.stockCountSession.update({ where: { id: sessionId }, data: { status: "REVIEW", submittedAt: new Date() } });
  await audit(user, { action: "count.submitted", entityType: "count", entityId: sessionId });
}

export const approveSchema = z.object({
  /** entry ids (wrong location / surplus) whose book should be recorded at the location where it was found */
  applyEntryIds: z.array(z.string().uuid()).max(5000).default([]),
  /** item ids reported missing that should be marked MISSING */
  markMissingItemIds: z.array(z.string().uuid()).max(5000).default([]),
});

/** Manager approval: applies only the corrections explicitly selected, then freezes the report. */
export async function approveCount(user: UserPrincipal, sessionId: string, input: z.infer<typeof approveSchema>) {
  const s = await db.stockCountSession.findFirst({ where: { id: sessionId, organizationId: user.organizationId } });
  if (!s) throw notFound("הספירה");
  if (s.status === "APPROVED" || s.status === "CANCELLED") throw new AppError("CONFLICT", "הספירה כבר נסגרה");
  const report = await countReport(user.organizationId, sessionId);
  const movable = new Map([...report.wrongLocation, ...report.surplus].map((x) => [x.entryId, x]));
  const missing = new Map(report.missing.map((m) => [m.itemId, m]));
  for (const id of input.applyEntryIds) if (!movable.has(id)) throw new AppError("CONFLICT", "הדו״ח השתנה מאז שנטען — רעננו ובחרו שוב");
  for (const id of input.markMissingItemIds) if (!missing.has(id)) throw new AppError("CONFLICT", "הדו״ח השתנה מאז שנטען — רעננו ובחרו שוב");

  await db.$transaction(
    async (tx) => {
      for (const id of input.applyEntryIds) {
        const x = movable.get(id)!;
        const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: x.itemId }, select: { physicalStatus: true } });
        if (item.physicalStatus === "SHIPPED") continue; // never "un-ship" from a count
        await moveItemTx(tx, user, x.itemId, x.foundId, "COUNT_ADJUST", { note: `ספירת מלאי ${sessionId.slice(0, 8)}` });
      }
      for (const id of input.markMissingItemIds) {
        await changeStatus(tx, user, id, "PHYSICAL", "MISSING", { refType: "count", refId: sessionId, reason: `לא נמצא בספירה (${missing.get(id)!.locationCode})` });
      }
      await tx.stockCountSession.update({
        where: { id: sessionId },
        data: { status: "APPROVED", approvedAt: new Date(), approvedById: user.userId, result: { report, applied: input } as object },
      });
    },
    { timeout: 60_000 },
  );
  await audit(user, { action: "count.approved", entityType: "count", entityId: sessionId, data: { moved: input.applyEntryIds.length, missing: input.markMissingItemIds.length } });
}

export async function cancelCount(user: UserPrincipal, sessionId: string) {
  const s = await db.stockCountSession.findFirst({ where: { id: sessionId, organizationId: user.organizationId } });
  if (!s) throw notFound("הספירה");
  if (s.status === "APPROVED") throw new AppError("CONFLICT", "ספירה מאושרת אינה ניתנת לביטול");
  await db.stockCountSession.update({ where: { id: sessionId }, data: { status: "CANCELLED" } });
  await audit(user, { action: "count.cancelled", entityType: "count", entityId: sessionId });
}
