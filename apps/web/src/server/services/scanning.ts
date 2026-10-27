import "server-only";
import { Prisma } from "@prisma/client";
import { classifyCode, type ScanOpInput, type ScanResponse, type ScannedCode } from "@avot/shared";
import { he } from "@/i18n/he";
import { db, type Tx } from "../db";
import { AppError, forbidden, notFound } from "../errors";
import { audit } from "../audit";
import { can } from "../auth/permissions";
import { canSeeHouse } from "../auth/houses";
import type { UserPrincipal } from "../auth/principal";
import { findItemByCode } from "./inventory";
import { changeStatus, storeBlockedReason } from "./item-status";
import { locationInclude, locationLabel } from "./location-label";
import { pickItemTx, shipItemTx } from "./picking";
import { findLocationByCode, moveItemTx } from "./warehouse";

/*
 * Handheld scans. Every scan carries a device-generated opId:
 *   - the same opId is never applied twice (BarcodeScanEvent + movement unique
 *     on opId); a retry gets the original outcome back, flagged `replayed`
 *   - a quick double scan of the same book has a new opId but is a NOOP
 *     ("already here"), not a second movement
 *   - an op synced late from the offline queue whose book was moved by someone
 *     else after the scan is NOT applied: it is stored as CONFLICT for a
 *     manager to resolve (never silently overwrites newer information)
 * Command barcodes only switch the device's mode; each op is authorised here
 * against the signed-in user's role, never by the barcode.
 */

type Outcome = Omit<ScanResponse, "opId" | "codeType"> & {
  codeType: ScanResponse["codeType"];
  itemId?: string | null;
  locationId?: string | null;
};

function requiredPermission(mode: ScanOpInput["mode"]) {
  return mode === "FIND" ? ("warehouse.view" as const) : ("warehouse.operate" as const);
}

/** Takes a book off its shelf for a while: it is no longer on a shelf, so it is "awaiting storage" until it is shelved again. */
async function tempOutTx(tx: Tx, user: UserPrincipal, itemId: string, op: ScanOpInput, base: { codeType: ScannedCode["type"]; itemId: string }): Promise<Outcome> {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  const blocked = storeBlockedReason(item.physicalStatus);
  if (blocked) return { ...base, result: "ERROR", message: blocked, item: await itemView(tx, user, itemId) };
  if (!item.currentLocationId) return { ...base, result: "NOOP", message: "הספר כבר אינו על מדף", item: await itemView(tx, user, itemId) };
  await moveItemTx(tx, user, itemId, null, "MANUAL", { opId: op.opId, occurredAt: op.deferred ? new Date(op.clientAt) : new Date(), note: "הוצאה זמנית" });
  await changeStatus(tx, user, itemId, "PHYSICAL", "AWAITING_STORAGE", { refType: "scan", reason: "הוצאה זמנית מהמדף" });
  return { ...base, result: "OK", message: `${item.inventoryNumber} הוצא זמנית — יש להחזירו למדף`, item: await itemView(tx, user, itemId) };
}

async function itemView(tx: Tx, user: UserPrincipal, itemId: string): Promise<NonNullable<ScanResponse["item"]>> {
  const i = await tx.inventoryItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      currentLocation: { include: locationInclude },
      lots: { where: { assignmentStatus: "ACTIVE" }, include: { catalog: { include: { auctionHouse: true } } } },
      pickTasks: { where: { status: { in: ["OPEN", "PICKED", "PACKED"] } } },
    },
  });
  const lot = i.lots[0];
  const allowed: string[] = [];
  if (!storeBlockedReason(i.physicalStatus)) allowed.push("אחסון / העברה");
  if (i.pickTasks.some((t) => t.status === "OPEN")) allowed.push("ליקוט");
  if (i.pickTasks.some((t) => t.status === "PICKED")) allowed.push("אריזה");
  if (i.pickTasks.some((t) => t.status === "PACKED")) allowed.push("משלוח");
  return {
    id: i.id,
    inventoryNumber: i.inventoryNumber,
    title: i.title,
    thumbUrl: i.primaryAssetId ? `/api/assets/${i.primaryAssetId}/thumb` : null,
    location: i.currentLocation ? { id: i.currentLocation.id, code: i.currentLocation.code, label: locationLabel(i.currentLocation) } : null,
    physicalStatus: i.physicalStatus,
    commercialStatus: i.commercialStatus,
    photoStatus: i.photoStatus,
    assignment: lot && canSeeHouse(user, lot.catalog.auctionHouseId) ? { house: lot.catalog.auctionHouse.name, catalogNumber: lot.catalog.number, lotNumber: lot.lotNumber } : null,
    allowed,
  };
}

const locView = (l: Awaited<ReturnType<typeof findLocationByCode>>) => (l ? { id: l.id, code: l.code, label: locationLabel(l) } : null);

async function contextLocation(tx: Tx, orgId: string, id: string | null | undefined) {
  if (!id) return null;
  return tx.storageLocation.findFirst({ where: { id, organizationId: orgId }, include: locationInclude });
}

async function handle(tx: Tx, user: UserPrincipal, op: ScanOpInput, code: ScannedCode): Promise<Outcome> {
  const orgId = user.organizationId;
  const err = (message: string, extra: Partial<Outcome> = {}): Outcome => ({ result: "ERROR", message, codeType: code.type, ...extra });

  if (code.type === "COMMAND") {
    if (code.mode !== "FIND" && !can(user.role, "warehouse.operate")) return err("אין לך הרשאה למצב זה");
    return { result: "OK", message: `מצב ${he.scanMode[code.mode]}`, codeType: "COMMAND" };
  }

  if (code.type === "ZONE") {
    // a column label identifies a column; a physical book always needs the exact shelf
    return err("זו תווית עמודה. סרקו את תווית המדף המדויק שעליו מניחים את הספר.");
  }

  if (code.type === "LOCATION") {
    const loc = await findLocationByCode(orgId, code.value, tx);
    if (!loc) return err(`מיקום ${code.value} לא קיים במערכת`);
    if (!loc.active) return err(`מיקום ${loc.code} מושבת`, { locationId: loc.id });
    const view = locView(loc)!;
    if (op.mode === "PICK") return err("במצב ליקוט סורקים את ברקוד הספר", { locationId: loc.id });
    if (op.mode === "FIND") {
      const n = await tx.inventoryItem.count({ where: { currentLocationId: loc.id } });
      return { result: "OK", message: `${view.label} · ${n} ספרים`, codeType: "LOCATION", activeLocation: view, locationId: loc.id };
    }
    if (op.mode === "COUNT") {
      const session = await openCountSession(tx, orgId, op.countSessionId);
      if (typeof session === "string") return err(session, { locationId: loc.id });
      await tx.stockCountLocation.upsert({
        where: { sessionId_locationId: { sessionId: session.id, locationId: loc.id } },
        create: { sessionId: session.id, locationId: loc.id, userId: user.userId },
        update: {},
      });
      const n = await tx.stockCountEntry.count({ where: { sessionId: session.id, locationId: loc.id } });
      return { result: "OK", message: `סופרים: ${loc.code}`, codeType: "LOCATION", activeLocation: view, locationId: loc.id, count: { sessionId: session.id, scannedInLocation: n } };
    }
    return { result: "OK", message: `מיקום פעיל: ${loc.code}`, codeType: "LOCATION", activeLocation: view, locationId: loc.id };
  }

  const found = await findItemByCode(orgId, code.value, tx);
  if (!found) return err(code.type === "UNKNOWN" ? `ברקוד לא מוכר: ${code.value}` : `ספר ${code.value} לא נמצא במלאי`);
  await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${found.id}::uuid FOR UPDATE`;
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: found.id } });
  const base = { codeType: code.type, itemId: item.id } as const;

  if (op.mode === "FIND") {
    const view = await itemView(tx, user, item.id);
    return { ...base, result: "OK", message: view.location ? view.location.label : "לספר אין מיקום במחסן", item: view };
  }

  if (op.mode === "PICK" && op.intent === "TEMP_OUT") return tempOutTx(tx, user, item.id, op, base);

  if (op.mode === "PICK" && op.intent === "FINAL_OUT") {
    if (!can(user.role, "pick.fulfil")) return { ...base, result: "ERROR", message: "אין לך הרשאה להוצאה סופית" };
    const r = await shipItemTx(tx, user, item.id, { opId: op.opId, occurredAt: op.deferred ? new Date(op.clientAt) : new Date() });
    const view = await itemView(tx, user, item.id);
    if (r.kind === "none") return { ...base, result: "ERROR", message: "לספר אין משימת משלוח — הוצאה סופית נעשית לספר שנמכר", item: view };
    if (r.kind === "already") return { ...base, result: "NOOP", message: "הספר כבר נשלח", item: view };
    return { ...base, result: "OK", message: `${item.inventoryNumber} הוצא סופית (נשלח)`, item: view };
  }

  if (op.mode === "PICK") {
    const r = await pickItemTx(tx, user, item.id, { opId: op.opId, occurredAt: new Date(op.clientAt) });
    const remaining = await tx.pickTask.count({ where: { organizationId: orgId, status: "OPEN" } });
    const view = await itemView(tx, user, item.id);
    if (r.kind === "none") return { ...base, result: "ERROR", message: "אין משימת ליקוט לספר זה — ייתכן שנסרק ספר שגוי", item: view };
    if (r.kind === "already") return { ...base, result: "NOOP", message: "הספר כבר לוקט", item: view, pick: { taskId: r.task.id, remaining } };
    return { ...base, result: "OK", message: `לוקט · נותרו ${remaining}`, item: view, pick: { taskId: r.task.id, remaining } };
  }

  const ctx = await contextLocation(tx, orgId, op.contextLocationId);
  if (!ctx) return { ...base, result: "ERROR", message: op.contextLocationId ? "המיקום הפעיל לא נמצא — סרקו מדף מחדש" : "סרקו קודם ברקוד של מדף" };

  if (op.mode === "COUNT") {
    const session = await openCountSession(tx, orgId, op.countSessionId);
    if (typeof session === "string") return { ...base, result: "ERROR", message: session };
    await tx.stockCountLocation.upsert({
      where: { sessionId_locationId: { sessionId: session.id, locationId: ctx.id } },
      create: { sessionId: session.id, locationId: ctx.id, userId: user.userId },
      update: {},
    });
    const existing = await tx.stockCountEntry.findUnique({ where: { sessionId_inventoryItemId: { sessionId: session.id, inventoryItemId: item.id } } });
    await tx.stockCountEntry.upsert({
      where: { sessionId_inventoryItemId: { sessionId: session.id, inventoryItemId: item.id } },
      create: { sessionId: session.id, locationId: ctx.id, inventoryItemId: item.id, expectedLocationId: item.currentLocationId, scannedById: user.userId },
      update: { locationId: ctx.id, scannedAt: new Date(), scannedById: user.userId },
    });
    const n = await tx.stockCountEntry.count({ where: { sessionId: session.id, locationId: ctx.id } });
    const view = await itemView(tx, user, item.id);
    const elsewhere = item.currentLocationId !== ctx.id;
    return {
      ...base,
      result: existing?.locationId === ctx.id ? "NOOP" : "OK",
      message: existing?.locationId === ctx.id ? `כבר נספר · ${n} במיקום` : elsewhere ? `נספר · רשום ב-${view.location?.code ?? "ללא מיקום"} (יוצג בפערים)` : `נספר · ${n} במיקום`,
      warning: elsewhere,
      item: view,
      activeLocation: locView(ctx),
      locationId: ctx.id,
      count: { sessionId: session.id, scannedInLocation: n },
    };
  }

  // STORE / TRANSFER
  if (!ctx.active) return { ...base, result: "ERROR", message: `מיקום ${ctx.code} מושבת` };
  const blocked = storeBlockedReason(item.physicalStatus);
  if (blocked) return { ...base, result: "ERROR", message: blocked, item: await itemView(tx, user, item.id) };
  if (item.currentLocationId === ctx.id) {
    return { ...base, result: "NOOP", message: `כבר במיקום ${ctx.code}`, item: await itemView(tx, user, item.id), activeLocation: locView(ctx), locationId: ctx.id };
  }
  const clientAt = new Date(op.clientAt);
  if (op.deferred && item.locationUpdatedAt && item.locationUpdatedAt > clientAt) {
    return {
      ...base,
      result: "CONFLICT",
      message: "הספר הוזז מאז הסריקה (סנכרון מאוחר) — הפעולה לא בוצעה והועברה לבדיקה",
      item: await itemView(tx, user, item.id),
      activeLocation: locView(ctx),
      locationId: ctx.id,
    };
  }
  await moveItemTx(tx, user, item.id, ctx.id, item.currentLocationId ? "TRANSFER" : "STORE", { opId: op.opId, occurredAt: op.deferred ? clientAt : new Date() });
  const view = await itemView(tx, user, item.id);
  return { ...base, result: "OK", message: `${item.inventoryNumber} → ${ctx.code}`, item: view, activeLocation: locView(ctx), locationId: ctx.id };
}

async function openCountSession(tx: Tx, orgId: string, id: string | null | undefined) {
  if (!id) return "לא נבחרה ספירה פעילה";
  const s = await tx.stockCountSession.findFirst({ where: { id, organizationId: orgId } });
  if (!s) return "הספירה לא נמצאה";
  if (s.status !== "OPEN") return "הספירה כבר הוגשה או נסגרה";
  return s;
}

async function replay(user: UserPrincipal, opId: string): Promise<ScanResponse | null> {
  const ev = await db.barcodeScanEvent.findUnique({ where: { organizationId_opId: { organizationId: user.organizationId, opId } } });
  if (!ev) return null;
  if (ev.userId && ev.userId !== user.userId) throw new AppError("CONFLICT", "מזהה הפעולה כבר שימש משתמש אחר");
  const item = ev.inventoryItemId ? await itemView(db, user, ev.inventoryItemId) : null;
  const loc = ev.locationId ? locView(await db.storageLocation.findUnique({ where: { id: ev.locationId }, include: locationInclude })) : null;
  return {
    opId,
    result: ev.result,
    message: ev.message ?? "",
    codeType: ev.codeType as ScanResponse["codeType"],
    item,
    activeLocation: ev.codeType === "LOCATION" || (ev.mode !== "FIND" && ev.mode !== "PICK") ? loc : null,
    replayed: true,
  };
}

/** Processes one scan. Throws 403 when the user's role does not allow the mode. */
export async function processScan(user: UserPrincipal, op: ScanOpInput): Promise<ScanResponse> {
  if (!can(user.role, requiredPermission(op.mode))) throw forbidden();
  const prior = await replay(user, op.opId);
  if (prior) return prior;

  const code = classifyCode(op.code);
  try {
    return await db.$transaction(async (tx) => {
      const out = await handle(tx, user, op, code);
      await tx.barcodeScanEvent.create({
        data: {
          organizationId: user.organizationId,
          opId: op.opId,
          userId: user.userId,
          mode: op.mode,
          code: op.code.slice(0, 200),
          codeType: code.type,
          inventoryItemId: out.itemId ?? null,
          locationId: out.locationId ?? null,
          contextLocationId: op.contextLocationId ?? null,
          result: out.result,
          message: out.message,
          clientAt: new Date(op.clientAt),
          deferred: !!op.deferred,
          deviceLabel: op.deviceLabel ?? null,
        },
      });
      if (out.result === "CONFLICT") {
        await audit(user, { action: "scan.conflict", entityType: "scan", entityId: op.opId, inventoryItemId: out.itemId ?? null, data: { code: op.code, mode: op.mode } }, tx);
      }
      const { itemId: _i, locationId: _l, ...response } = out;
      return { opId: op.opId, ...response };
    });
  } catch (e) {
    // the same opId raced in on two connections — the first one won; return its outcome
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await replay(user, op.opId);
      if (again) return again;
    }
    if (e instanceof AppError && e.code === "CONFLICT") {
      // a business rule refused the move inside the transaction (e.g. shipped meanwhile)
      await db.barcodeScanEvent
        .create({
          data: {
            organizationId: user.organizationId,
            opId: op.opId,
            userId: user.userId,
            mode: op.mode,
            code: op.code.slice(0, 200),
            codeType: code.type,
            contextLocationId: op.contextLocationId ?? null,
            result: "ERROR",
            message: e.message,
            clientAt: new Date(op.clientAt),
            deferred: !!op.deferred,
          },
        })
        .catch(() => undefined);
      return { opId: op.opId, result: "ERROR", message: e.message, codeType: code.type };
    }
    throw e;
  }
}

/* ───────────────── scan log & conflict review ───────────────── */

export async function listScanEvents(orgId: string, opts: { onlyOpen?: boolean; result?: string; take?: number } = {}) {
  const rows = await db.barcodeScanEvent.findMany({
    where: {
      organizationId: orgId,
      ...(opts.onlyOpen ? { result: "CONFLICT", resolvedAt: null } : opts.result ? { result: opts.result as never } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: Math.min(opts.take ?? 200, 1000),
  });
  const ids = (k: "userId" | "inventoryItemId" | "locationId" | "contextLocationId") => [...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x))];
  const [users, items, locs] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids("userId") } }, select: { id: true, name: true } }),
    db.inventoryItem.findMany({ where: { id: { in: ids("inventoryItemId") } }, select: { id: true, inventoryNumber: true, title: true, currentLocation: { select: { code: true } } } }),
    db.storageLocation.findMany({ where: { id: { in: [...ids("locationId"), ...ids("contextLocationId")] } }, select: { id: true, code: true } }),
  ]);
  const u = new Map(users.map((x) => [x.id, x.name]));
  const it = new Map(items.map((x) => [x.id, x]));
  const lc = new Map(locs.map((x) => [x.id, x.code]));
  return rows.map((r) => ({
    id: r.id,
    opId: r.opId,
    mode: r.mode,
    code: r.code,
    codeType: r.codeType,
    result: r.result,
    message: r.message,
    clientAt: r.clientAt.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    deferred: r.deferred,
    userName: r.userId ? (u.get(r.userId) ?? null) : null,
    item: r.inventoryItemId ? (it.get(r.inventoryItemId) ?? null) : null,
    location: r.locationId ? (lc.get(r.locationId) ?? null) : null,
    contextLocation: r.contextLocationId ? (lc.get(r.contextLocationId) ?? null) : null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolution: r.resolution,
  }));
}

/** Manager decision on a CONFLICT scan: apply it now (the scanned location wins) or dismiss it. */
export async function resolveConflict(user: UserPrincipal, eventId: string, action: "apply" | "dismiss") {
  const ev = await db.barcodeScanEvent.findFirst({ where: { id: eventId, organizationId: user.organizationId } });
  if (!ev) throw notFound("הסריקה");
  if (ev.result !== "CONFLICT" || ev.resolvedAt) throw new AppError("CONFLICT", "הסריקה אינה ממתינה להחלטה");
  await db.$transaction(async (tx) => {
    if (action === "apply") {
      if (!ev.inventoryItemId || !ev.locationId) throw new AppError("VALIDATION", "חסרים פרטי ספר או מיקום");
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: ev.inventoryItemId } });
      const blocked = storeBlockedReason(item.physicalStatus);
      if (blocked) throw new AppError("CONFLICT", blocked);
      if (item.currentLocationId !== ev.locationId) await moveItemTx(tx, user, item.id, ev.locationId, "TRANSFER", { note: `אושר מסריקה מאוחרת ${ev.opId.slice(0, 8)}` });
    }
    await tx.barcodeScanEvent.update({ where: { id: ev.id }, data: { resolvedAt: new Date(), resolvedById: user.userId, resolution: action === "apply" ? "APPLIED" : "DISMISSED" } });
    await audit(user, { action: `scan.conflict_${action === "apply" ? "applied" : "dismissed"}`, entityType: "scan", entityId: ev.id, inventoryItemId: ev.inventoryItemId }, tx);
  });
}
