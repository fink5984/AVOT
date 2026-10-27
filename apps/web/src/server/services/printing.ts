import "server-only";
import { z } from "zod";
import { formatZoneCode } from "@avot/shared";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import type { DevicePrincipal, UserPrincipal } from "../auth/principal";
import { labelStock, renderZpl, type PrintLabel } from "../labels/zpl";
import { locationInclude } from "./location-label";
import { isOnline } from "./devices";

/*
 * Central label printing.
 *
 *   browser / phone ── POST /api/print/jobs ──▶ PrintJob (PENDING, durable in PostgreSQL)
 *   print agent (a paired Device of kind PRINT, sitting next to the printer) ── outbound HTTPS ──▶
 *       claim → server renders ZPL → agent sends it to the printer (TCP 9100 / Windows spooler) → report
 *
 * The server never connects to a printer's local address. A job moves PENDING → CLAIMED → SENT → DONE.
 * SENT means "written to the printer"; only DONE (the printer answered that nothing is left in its
 * buffer) is shown as printed — printers that cannot report stay at SENT and say so in the UI.
 */

export const MAX_LABELS_PER_JOB = 40;
/** a claimed job nobody reported on within this window is handed out again (the agent is gone) */
const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export type PrintItemRef = { type: "BOOK" | "LOCATION" | "ZONE"; id: string };

export const printRequestSchema = z.object({
  /** books, shelves and columns to print — any mix */
  items: z.array(z.object({ type: z.enum(["BOOK", "LOCATION", "ZONE"]), id: z.string().uuid() })).max(2000).default([]),
  /** every shelf (+ the column label) of a column */
  zoneId: z.string().uuid().optional(),
  /** every shelf and column label of a warehouse */
  warehouseId: z.string().uuid().optional(),
  copies: z.number().int().min(1).max(20).default(1),
  printerId: z.string().uuid().optional(),
  /** key of the click: the same key never creates (or prints) the batch twice */
  idemKey: z.string().min(8).max(100).optional(),
});
export type PrintRequest = z.input<typeof printRequestSchema>;

export const printerSchema = z.object({
  name: z.string().trim().min(1, "שם המדפסת נדרש").max(100),
  model: z.string().trim().max(100).nullish(),
  connection: z.enum(["NETWORK", "WINDOWS"]).default("NETWORK"),
  host: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, "כתובת לא תקינה")
    .nullish(),
  port: z.number().int().min(1).max(65535).default(9100),
  windowsName: z.string().trim().max(200).nullish(),
  labelSize: z.enum(["50x25", "57x32", "70x40", "100x50"]).default("57x32"),
  dotsPerMm: z.union([z.literal(8), z.literal(12)]).default(8),
  agentId: z.string().uuid().nullish(),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),
});
export const printerPatchSchema = printerSchema.partial();

/* ───────────────────────── printers ───────────────────────── */

function validateConnection(p: { connection?: string; host?: string | null; windowsName?: string | null }) {
  if (p.connection === "NETWORK" && !p.host) throw new AppError("VALIDATION", "מדפסת רשת דורשת כתובת IP");
  if (p.connection === "WINDOWS" && !p.windowsName) throw new AppError("VALIDATION", "יש לציין את שם המדפסת ב-Windows");
}

export async function listPrinters(orgId: string) {
  const [printers, agents] = await Promise.all([
    db.printer.findMany({ where: { organizationId: orgId }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }),
    db.device.findMany({ where: { organizationId: orgId, kind: "PRINT", revokedAt: null }, orderBy: { name: "asc" } }),
  ]);
  return {
    agents: agents.map((a) => ({ id: a.id, name: a.name, machineName: a.machineName, agentVersion: a.agentVersion, online: isOnline(a.lastSeenAt), lastSeenAt: a.lastSeenAt?.toISOString() ?? null })),
    printers: printers.map((p) => {
      const agent = agents.find((a) => a.id === p.agentId) ?? (p.agentId ? undefined : agents.find((a) => isOnline(a.lastSeenAt)) ?? agents[0]);
      return { ...p, agentOnline: agent ? isOnline(agent.lastSeenAt) : false, agentName: agent?.name ?? null };
    }),
  };
}

export async function createPrinter(user: UserPrincipal, input: z.infer<typeof printerSchema>) {
  validateConnection(input);
  const count = await db.printer.count({ where: { organizationId: user.organizationId } });
  const makePrimary = input.isPrimary ?? count === 0;
  const printer = await db.$transaction(async (tx) => {
    if (makePrimary) await tx.printer.updateMany({ where: { organizationId: user.organizationId, isPrimary: true }, data: { isPrimary: false } });
    return tx.printer.create({
      data: {
        organizationId: user.organizationId,
        name: input.name,
        model: input.model ?? null,
        connection: input.connection,
        host: input.host ?? null,
        port: input.port,
        windowsName: input.windowsName ?? null,
        labelSize: input.labelSize,
        dotsPerMm: input.dotsPerMm,
        agentId: input.agentId ?? null,
        isPrimary: makePrimary,
        active: input.active ?? true,
      },
    });
  });
  await audit(user, { action: "printer.created", entityType: "settings", entityId: printer.id, data: { name: printer.name } });
  return printer;
}

export async function updatePrinter(user: UserPrincipal, id: string, input: z.infer<typeof printerPatchSchema>) {
  const existing = await db.printer.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!existing) throw notFound("המדפסת");
  validateConnection({ connection: input.connection ?? existing.connection, host: input.host === undefined ? existing.host : input.host, windowsName: input.windowsName === undefined ? existing.windowsName : input.windowsName });
  const printer = await db.$transaction(async (tx) => {
    if (input.isPrimary) await tx.printer.updateMany({ where: { organizationId: user.organizationId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
    return tx.printer.update({ where: { id }, data: { ...input, isPrimary: input.active === false ? false : input.isPrimary } });
  });
  await audit(user, { action: "printer.updated", entityType: "settings", entityId: id, data: input as object });
  return printer;
}

export async function deletePrinter(user: UserPrincipal, id: string) {
  const existing = await db.printer.findFirst({ where: { id, organizationId: user.organizationId } });
  if (!existing) throw notFound("המדפסת");
  await db.$transaction(async (tx) => {
    // queued jobs of a removed printer fall back to the primary printer (printerId → null)
    await tx.printer.delete({ where: { id } });
    if (existing.isPrimary) {
      const next = await tx.printer.findFirst({ where: { organizationId: user.organizationId, active: true }, orderBy: { createdAt: "asc" } });
      if (next) await tx.printer.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  });
  await audit(user, { action: "printer.deleted", entityType: "settings", entityId: id, data: { name: existing.name } });
}

async function resolvePrinter(orgId: string, printerId?: string) {
  const printer = printerId
    ? await db.printer.findFirst({ where: { id: printerId, organizationId: orgId } })
    : await db.printer.findFirst({ where: { organizationId: orgId, isPrimary: true, active: true } });
  if (!printer) throw new AppError("CONFLICT", printerId ? "המדפסת לא נמצאה" : "לא הוגדרה מדפסת ראשית. הגדירו מדפסת בהגדרות ← מדפסת תוויות.");
  if (!printer.active) throw new AppError("CONFLICT", "המדפסת מושבתת");
  return printer;
}

/* ───────────────────────── queue ───────────────────────── */

const zoneOf = (z: { code: string; warehouse: { code: string; isDefault: boolean } }) => formatZoneCode({ warehouse: z.warehouse.isDefault ? null : z.warehouse.code, zone: z.code });

async function expandRequest(orgId: string, req: z.output<typeof printRequestSchema>): Promise<PrintItemRef[]> {
  const out: PrintItemRef[] = [...req.items];
  if (req.zoneId) {
    const zone = await db.warehouseZone.findFirst({
      where: { id: req.zoneId, warehouse: { organizationId: orgId } },
      include: { shelves: { orderBy: { sortOrder: "asc" }, include: { locations: { where: { active: true }, orderBy: { sortKey: "asc" } } } } },
    });
    if (!zone) throw notFound("העמודה");
    out.push({ type: "ZONE", id: zone.id });
    for (const s of zone.shelves) for (const l of s.locations) out.push({ type: "LOCATION", id: l.id });
  }
  if (req.warehouseId) {
    const wh = await db.warehouse.findFirst({
      where: { id: req.warehouseId, organizationId: orgId },
      include: { zones: { orderBy: { sortOrder: "asc" }, include: { shelves: { orderBy: { sortOrder: "asc" }, include: { locations: { where: { active: true }, orderBy: { sortKey: "asc" } } } } } } },
    });
    if (!wh) throw notFound("המחסן");
    for (const z of wh.zones) {
      out.push({ type: "ZONE", id: z.id });
      for (const s of z.shelves) for (const l of s.locations) out.push({ type: "LOCATION", id: l.id });
    }
  }
  // the same thing twice in one request is one label (copies is the way to ask for more)
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(`${i.type}:${i.id}`) ? false : (seen.add(`${i.type}:${i.id}`), true)));
}

/** Creates the print job(s) for a click. Idempotent on idemKey. Returns the jobs (several for big batches). */
export async function createPrintJobs(user: UserPrincipal, input: z.input<typeof printRequestSchema>) {
  const req = printRequestSchema.parse(input);
  const printer = await resolvePrinter(user.organizationId, req.printerId);
  const items = await expandRequest(user.organizationId, req);
  if (!items.length) throw new AppError("VALIDATION", "לא נבחרו תוויות להדפסה");

  // validate and summarise (ids that do not belong to this organization are refused, not skipped)
  const bookIds = items.filter((i) => i.type === "BOOK").map((i) => i.id);
  const locIds = items.filter((i) => i.type === "LOCATION").map((i) => i.id);
  const zoneIds = items.filter((i) => i.type === "ZONE").map((i) => i.id);
  const [books, locs, zones] = await Promise.all([
    bookIds.length ? db.inventoryItem.findMany({ where: { organizationId: user.organizationId, id: { in: bookIds }, deletionRequestedAt: null }, select: { id: true, inventoryNumber: true, title: true } }) : [],
    locIds.length ? db.storageLocation.count({ where: { organizationId: user.organizationId, id: { in: locIds } } }) : 0,
    zoneIds.length ? db.warehouseZone.count({ where: { id: { in: zoneIds }, warehouse: { organizationId: user.organizationId } } }) : 0,
  ]);
  if (books.length !== bookIds.length || locs !== locIds.length || zones !== zoneIds.length) throw new AppError("NOT_FOUND", "חלק מהפריטים להדפסה לא נמצאו");

  const chunks: PrintItemRef[][] = [];
  for (let i = 0; i < items.length; i += MAX_LABELS_PER_JOB) chunks.push(items.slice(i, i + MAX_LABELS_PER_JOB));
  const bookInfo = new Map(books.map((b) => [b.id, b]));

  const jobs = [];
  for (let n = 0; n < chunks.length; n++) {
    const chunk = chunks[n]!;
    const idemKey = req.idemKey ? `${req.idemKey}:${n}` : null;
    if (idemKey) {
      const prior = await db.printJob.findUnique({ where: { organizationId_idemKey: { organizationId: user.organizationId, idemKey } } });
      if (prior) {
        jobs.push(prior);
        continue;
      }
    }
    const first = chunk[0]!;
    const summary =
      first.type === "BOOK"
        ? `${bookInfo.get(first.id)?.inventoryNumber ?? ""} · ${bookInfo.get(first.id)?.title ?? ""}`.slice(0, 120)
        : first.type === "LOCATION"
          ? "תווית מדף"
          : "תווית עמודה";
    try {
      const job = await db.printJob.create({
        data: {
          organizationId: user.organizationId,
          printerId: printer.id,
          kind: chunk.every((c) => c.type === "BOOK") ? "BOOK" : "LOCATION",
          items: chunk as unknown as Prisma.InputJsonValue,
          copies: req.copies,
          labelCount: chunk.length * req.copies,
          idemKey,
          summary: chunk.length > 1 ? `${summary} ועוד ${chunk.length - 1}` : summary,
          createdById: user.userId,
        },
      });
      jobs.push(job);
    } catch (err) {
      // a concurrent request with the same key won the race
      const prior = idemKey ? await db.printJob.findUnique({ where: { organizationId_idemKey: { organizationId: user.organizationId, idemKey } } }) : null;
      if (!prior) throw err;
      jobs.push(prior);
    }
  }
  await audit(user, { action: "print.requested", entityType: "settings", entityId: jobs[0]?.id, data: { labels: items.length, copies: req.copies, jobs: jobs.length } });
  return jobs;
}

export async function createTestPrint(user: UserPrincipal, printerId: string) {
  const printer = await resolvePrinter(user.organizationId, printerId);
  const job = await db.printJob.create({
    data: {
      organizationId: user.organizationId,
      printerId: printer.id,
      kind: "TEST",
      items: [{ type: "TEST" }] as unknown as Prisma.InputJsonValue,
      copies: 1,
      labelCount: 1,
      summary: "הדפסת ניסיון",
      createdById: user.userId,
    },
  });
  await audit(user, { action: "print.test", entityType: "settings", entityId: printer.id });
  return job;
}

export async function listPrintJobs(orgId: string, opts: { limit?: number; status?: string } = {}) {
  const jobs = await db.printJob.findMany({
    where: { organizationId: orgId, ...(opts.status ? { status: opts.status as never } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
    include: { printer: { select: { name: true } } },
  });
  const users = await db.user.findMany({ where: { id: { in: jobs.map((j) => j.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return jobs.map((j) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    summary: j.summary,
    labelCount: j.labelCount,
    attempts: j.attempts,
    error: j.error,
    printerName: j.printer?.name ?? null,
    createdBy: j.createdById ? (names.get(j.createdById) ?? null) : null,
    createdAt: j.createdAt.toISOString(),
    sentAt: j.sentAt?.toISOString() ?? null,
    doneAt: j.doneAt?.toISOString() ?? null,
  }));
}

export async function getPrintJob(orgId: string, id: string) {
  const j = await db.printJob.findFirst({ where: { id, organizationId: orgId } });
  if (!j) throw notFound("משימת ההדפסה");
  return j;
}

/** New job with the same content (the old one stays in the log). */
export async function reprintJob(user: UserPrincipal, id: string) {
  const old = await getPrintJob(user.organizationId, id);
  const printer = await resolvePrinter(user.organizationId, old.printerId ?? undefined);
  const job = await db.printJob.create({
    data: {
      organizationId: user.organizationId,
      printerId: printer.id,
      kind: old.kind,
      items: old.items as Prisma.InputJsonValue,
      copies: old.copies,
      labelCount: old.labelCount,
      summary: old.summary,
      createdById: user.userId,
    },
  });
  await audit(user, { action: "print.reprint", entityType: "settings", entityId: job.id, data: { from: id } });
  return job;
}

export async function cancelPrintJob(user: UserPrincipal, id: string) {
  const j = await getPrintJob(user.organizationId, id);
  if (j.status !== "PENDING" && j.status !== "CLAIMED") throw new AppError("CONFLICT", "אפשר לבטל רק משימה שעדיין לא נשלחה למדפסת");
  const r = await db.printJob.updateMany({ where: { id, status: { in: ["PENDING", "CLAIMED"] } }, data: { status: "CANCELLED", error: "בוטל" } });
  if (!r.count) throw new AppError("CONFLICT", "המשימה כבר נשלחה למדפסת");
  await audit(user, { action: "print.cancelled", entityType: "settings", entityId: id });
}

/* ───────────────────────── print agent API ───────────────────────── */

async function assertPrintAgent(device: DevicePrincipal) {
  const d = await db.device.findUnique({ where: { id: device.deviceId }, select: { kind: true, revokedAt: true } });
  if (!d || d.revokedAt || d.kind !== "PRINT") throw new AppError("FORBIDDEN", "הרכיב אינו סוכן הדפסה מורשה");
}

/** Releases claims whose agent disappeared; gives up after MAX_ATTEMPTS. */
async function requeueStale(orgId: string) {
  const cutoff = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  await db.printJob.updateMany({ where: { organizationId: orgId, status: "CLAIMED", claimedAt: { lt: cutoff }, attempts: { lt: MAX_ATTEMPTS } }, data: { status: "PENDING", claimedById: null } });
  await db.printJob.updateMany({ where: { organizationId: orgId, status: "CLAIMED", claimedAt: { lt: cutoff }, attempts: { gte: MAX_ATTEMPTS } }, data: { status: "FAILED", error: "סוכן ההדפסה לא דיווח על המשימה" } });
}

async function labelsFor(orgId: string, items: PrintItemRef[] | { type: "TEST" }[]): Promise<PrintLabel[]> {
  const out: PrintLabel[] = [];
  const refs = items as { type: string; id?: string }[];
  const books = await db.inventoryItem.findMany({ where: { organizationId: orgId, id: { in: refs.filter((r) => r.type === "BOOK").map((r) => r.id!) } } });
  const locs = await db.storageLocation.findMany({ where: { organizationId: orgId, id: { in: refs.filter((r) => r.type === "LOCATION").map((r) => r.id!) } }, include: locationInclude });
  const zones = await db.warehouseZone.findMany({ where: { id: { in: refs.filter((r) => r.type === "ZONE").map((r) => r.id!) }, warehouse: { organizationId: orgId } }, include: { warehouse: true } });
  const num = (code: string) => (/^\d+$/.test(code) ? String(Number(code)) : code);
  for (const r of refs) {
    if (r.type === "BOOK") {
      const b = books.find((x) => x.id === r.id);
      if (b) out.push({ type: "BOOK", code: b.barcode, inventoryNumber: b.inventoryNumber, title: b.title });
    } else if (r.type === "LOCATION") {
      const l = locs.find((x) => x.id === r.id);
      if (l) {
        const z = l.shelf.zone;
        const cells = l.cell !== "01" && l.cell !== "1" ? ` · תא ${num(l.cell)}` : "";
        out.push({
          type: "LOCATION",
          code: l.code,
          shelf: `מדף ${num(l.shelf.code)}${cells}`,
          path: [z.warehouse.name, z.name || `עמודה ${num(z.code)}`].join(" › "),
        });
      }
    } else if (r.type === "ZONE") {
      const z = zones.find((x) => x.id === r.id);
      if (z) out.push({ type: "ZONE", code: zoneOf(z), name: z.name || `עמודה ${num(z.code)}`, warehouse: z.warehouse.name });
    } else if (r.type === "TEST") out.push({ type: "TEST", text: "AVOT · בדיקת הדפסה" });
  }
  return out;
}

/**
 * Hands the oldest runnable job to the calling agent (null when there is none). The ZPL is rendered
 * here so layout fixes ship with the server, never with the agent.
 */
export async function claimNextPrintJob(device: DevicePrincipal) {
  await assertPrintAgent(device);
  await db.device.update({ where: { id: device.deviceId }, data: { lastSeenAt: new Date() } });
  await requeueStale(device.organizationId);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "PrintJob" SET status = 'CLAIMED', "claimedAt" = now(), "claimedById" = ${device.deviceId}::uuid, attempts = attempts + 1, "updatedAt" = now()
    WHERE id = (
      SELECT j.id FROM "PrintJob" j
      LEFT JOIN "Printer" p ON p.id = j."printerId"
      WHERE j."organizationId" = ${device.organizationId}::uuid AND j.status = 'PENDING'
        AND (p.id IS NULL OR p."agentId" IS NULL OR p."agentId" = ${device.deviceId}::uuid)
      ORDER BY j."createdAt"
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING id`;
  const id = rows[0]?.id;
  if (!id) return null;
  const job = await db.printJob.findUniqueOrThrow({ where: { id }, include: { printer: true } });
  const printer = job.printer ?? (await db.printer.findFirst({ where: { organizationId: device.organizationId, isPrimary: true, active: true } }));
  if (!printer) {
    await db.printJob.update({ where: { id }, data: { status: "FAILED", error: "אין מדפסת מוגדרת למשימה" } });
    return null;
  }
  try {
    const labels = await labelsFor(job.organizationId, job.items as never);
    if (!labels.length) throw new Error("התוויות להדפסה כבר לא קיימות");
    const zpl = await renderZpl(labels, { stock: labelStock(printer.labelSize), dotsPerMm: printer.dotsPerMm, copies: job.copies });
    return {
      jobId: job.id,
      attempt: job.attempts,
      labelCount: job.labelCount,
      printer: { id: printer.id, name: printer.name, connection: printer.connection, host: printer.host, port: printer.port, windowsName: printer.windowsName, language: printer.language },
      zpl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("print job render failed", { jobId: id, err });
    await db.printJob.update({ where: { id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    return null;
  }
}

export const printReportSchema = z.object({
  status: z.enum(["SENT", "DONE", "FAILED"]),
  error: z.string().max(500).nullish(),
});

/** The agent reports what happened. Transitions only move forward, so a repeated report is harmless. */
export async function reportPrintJob(device: DevicePrincipal, jobId: string, input: z.infer<typeof printReportSchema>) {
  await assertPrintAgent(device);
  const job = await db.printJob.findFirst({ where: { id: jobId, organizationId: device.organizationId } });
  if (!job) throw notFound("משימת ההדפסה");
  const now = new Date();
  const allowed: Record<string, string[]> = { SENT: ["CLAIMED", "PENDING"], DONE: ["CLAIMED", "SENT", "PENDING"], FAILED: ["CLAIMED", "SENT", "PENDING"] };
  if (!allowed[input.status]!.includes(job.status)) return { status: job.status, ignored: true };
  const data: Prisma.PrintJobUpdateManyMutationInput =
    input.status === "SENT"
      ? { status: "SENT", sentAt: now, error: null }
      : input.status === "DONE"
        ? { status: "DONE", doneAt: now, sentAt: job.sentAt ?? now, error: null }
        : { status: "FAILED", error: input.error ?? "ההדפסה נכשלה" };
  await db.printJob.updateMany({ where: { id: jobId, status: { in: allowed[input.status] as never } }, data });
  if (job.printerId) {
    await db.printer.update({
      where: { id: job.printerId },
      data: input.status === "FAILED" ? { lastStatus: "ERROR", lastStatusAt: now, lastError: input.error ?? "ההדפסה נכשלה" } : { lastStatus: "OK", lastStatusAt: now, lastError: null },
    });
  }
  return { status: input.status, ignored: false };
}

export const printHeartbeatSchema = z.object({
  agentVersion: z.string().max(50),
  machineName: z.string().max(200).optional(),
  /** per printer the agent drives, as far as the printer can tell (host status query ~HS) */
  printers: z
    .array(z.object({ printerId: z.string().uuid(), state: z.enum(["OK", "OFFLINE", "PAPER_OUT", "HEAD_OPEN", "PAUSED", "ERROR"]), detail: z.string().max(300).nullish() }))
    .max(20)
    .default([]),
});

const STATE_TEXT: Record<string, string> = { OK: "מחוברת", OFFLINE: "לא מגיבה", PAPER_OUT: "נגמרו המדבקות", HEAD_OPEN: "מכסה פתוח", PAUSED: "מושהית", ERROR: "שגיאה" };

export async function printAgentHeartbeat(device: DevicePrincipal, hb: z.infer<typeof printHeartbeatSchema>) {
  await assertPrintAgent(device);
  await db.device.update({ where: { id: device.deviceId }, data: { agentVersion: hb.agentVersion, machineName: hb.machineName, lastSeenAt: new Date(), printStatus: hb.printers as unknown as Prisma.InputJsonValue } });
  for (const p of hb.printers) {
    await db.printer.updateMany({
      where: { id: p.printerId, organizationId: device.organizationId },
      data: { lastStatus: p.state, lastStatusAt: new Date(), lastError: p.state === "OK" ? null : (p.detail ?? STATE_TEXT[p.state]) },
    });
  }
  const printers = await db.printer.findMany({ where: { organizationId: device.organizationId, active: true, OR: [{ agentId: null }, { agentId: device.deviceId }] } });
  return {
    serverTime: new Date().toISOString(),
    printers: printers.map((p) => ({ id: p.id, name: p.name, connection: p.connection, host: p.host, port: p.port, windowsName: p.windowsName, language: p.language })),
  };
}

export const PRINTER_STATE_TEXT = STATE_TEXT;
