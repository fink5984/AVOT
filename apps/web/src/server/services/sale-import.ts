import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { asJson } from "../json";
import { storage } from "../storage";
import { addMoney } from "@/lib/money";
import { detectMapping, fileKind, normalizeRows, parseSaleFile, type ImportMapping, type NormalizedRow } from "../sales/import-format";
import { attachIdentities, createCustomerTx, matchCustomer, normEmail, normPhone, type Address } from "./customers";
import { recordSaleTx } from "./sales";
import { syncItemCommercial } from "./assignments";
import { memberItemIds } from "./lot-members";

/*
 * Sale results enter through ONE door whatever the source (Excel, CSV, a future API adapter): rows are normalised
 * (sales/import-format.ts), then matched to lots and customers and applied here. The preview is the real commit run inside a
 * transaction that is rolled back, so what is shown is exactly what would happen. A file is never trusted to be complete:
 * lots missing from it are left alone, never concluded "unsold".
 */

export const mappingSchema = z.object({
  results: z.record(z.string(), z.string()),
  buyers: z
    .object({ key: z.enum(["bidderNumber", "buyerId"]), keyHeader: z.string(), columns: z.record(z.string(), z.string()) })
    .optional(),
  soldWords: z.array(z.string().max(40)).max(20).optional(),
  unsoldWords: z.array(z.string().max(40)).max(20).optional(),
});

export type RowAction = "CREATE" | "UPDATE" | "UNCHANGED" | "CONFLICT" | "SKIP" | "ERROR";
export type CustomerMatchKind = "EXISTING" | "NEW" | "NEEDS_DETAILS" | "AMBIGUOUS" | "NONE";

export interface RowResult {
  rowIndex: number;
  lotNumber: number | null;
  lotId: string | null;
  outcome: NormalizedRow["outcome"];
  hammerPrice: string | null;
  buyerLabel: string | null;
  customerId: string | null;
  customerMatch: CustomerMatchKind;
  action: RowAction;
  messages: string[];
  purchaseId: string | null;
}

export interface ImportSummary {
  rowsInFile: number;
  sold: number;
  unsold: number;
  unknown: number;
  hammerTotal: string;
  buyers: number;
  newCustomers: number;
  existingCustomers: number;
  needsDetails: number;
  ambiguous: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  skipped: number;
  /** active lots of the catalog that the file does not mention: left untouched */
  lotsNotInFile: number;
}

/* ───────────────────────── upload ───────────────────────── */

const key = (orgId: string, importId: string, name: string) => `orgs/${orgId}/sale-imports/${importId}/${name.replace(/[^\w.\-]+/g, "_").slice(0, 80)}`;

export async function createImport(
  user: UserPrincipal,
  catalogId: string,
  input: { fileName: string; buffer: Buffer; buyers?: { fileName: string; buffer: Buffer } | null; templateId?: string | null },
) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  let file;
  let buyersFile = null;
  try {
    file = await parseSaleFile(input.fileName, input.buffer);
    if (input.buyers) buyersFile = await parseSaleFile(input.buyers.fileName, input.buyers.buffer);
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }
  let mapping: ImportMapping = { results: detectMapping(file.headers) };
  if (input.templateId) {
    const t = await db.saleImportTemplate.findFirst({ where: { id: input.templateId, organizationId: user.organizationId } });
    if (t) mapping = mappingSchema.parse(t.mapping) as ImportMapping;
  }
  if (buyersFile && !mapping.buyers) {
    const det = detectMapping(buyersFile.headers);
    const k = mapping.results.bidderNumber ? "bidderNumber" : mapping.results.buyerId ? "buyerId" : "bidderNumber";
    mapping.buyers = { key: k, keyHeader: det[k] ?? buyersFile.headers[0]!, columns: det };
  }
  const imp = await db.saleResultImport.create({
    data: {
      organizationId: user.organizationId,
      catalogId,
      source: fileKind(input.fileName, input.buffer),
      fileName: input.fileName,
      fileHash: createHash("sha256").update(input.buffer).digest("hex"),
      buyersFileName: input.buyers?.fileName ?? null,
      buyersFileHash: input.buyers ? createHash("sha256").update(input.buyers.buffer).digest("hex") : null,
      mapping: asJson(mapping),
      createdById: user.userId,
    },
  });
  const storageKey = key(user.organizationId, imp.id, input.fileName);
  await storage().putBuffer(storageKey, input.buffer, "application/octet-stream");
  let buyersKey: string | null = null;
  if (input.buyers) {
    buyersKey = key(user.organizationId, imp.id, `buyers-${input.buyers.fileName}`);
    await storage().putBuffer(buyersKey, input.buyers.buffer, "application/octet-stream");
  }
  await db.saleResultImport.update({ where: { id: imp.id }, data: { storageKey, buyersStorageKey: buyersKey } });
  // the same file uploaded before: say so (it is allowed - the commit will not duplicate anything)
  const same = await db.saleResultImport.count({ where: { organizationId: user.organizationId, catalogId, fileHash: imp.fileHash, status: "COMMITTED" } });
  return { importId: imp.id, headers: file.headers, buyersHeaders: buyersFile?.headers ?? null, mapping, rowsInFile: file.rows.length, previouslyImported: same > 0 };
}

/* ───────────────────────── planning / applying ───────────────────────── */

class Rollback extends Error {
  constructor(readonly payload: { rows: RowResult[]; summary: ImportSummary }) {
    super("rollback");
  }
}

async function loadFiles(imp: { storageKey: string | null; fileName: string; buyersStorageKey: string | null; buyersFileName: string | null }) {
  if (!imp.storageKey) throw new AppError("INTERNAL", "קובץ המקור לא נשמר");
  const file = await parseSaleFile(imp.fileName, await storage().getBuffer(imp.storageKey));
  const buyers = imp.buyersStorageKey && imp.buyersFileName ? await parseSaleFile(imp.buyersFileName, await storage().getBuffer(imp.buyersStorageKey)) : null;
  return { file, buyers };
}

function addressFrom(text: string | null): Address[] {
  return text ? [{ line1: text.slice(0, 300) }] : [];
}

async function applyRows(tx: Tx, user: UserPrincipal, imp: { id: string; catalogId: string }, rows: NormalizedRow[]) {
  const results: RowResult[] = [];
  const lots = await tx.lot.findMany({ where: { catalogId: imp.catalogId, mergedIntoLotId: null } });
  const byNumber = new Map(lots.map((l) => [l.lotNumber, l]));
  const byExternal = new Map(lots.filter((l) => l.externalRef).map((l) => [l.externalRef!, l]));
  const seenLots = new Set<string>();
  const buyers = new Set<string>();
  const newCustomers = new Set<string>();
  const existingCustomers = new Set<string>();
  const needsDetails = new Set<string>();

  for (const r of rows) {
    const res: RowResult = {
      rowIndex: r.rowIndex,
      lotNumber: r.lotNumber,
      lotId: null,
      outcome: r.outcome,
      hammerPrice: r.hammerPrice,
      buyerLabel: r.buyerName ?? (r.bidderNumber ? `מציע ${r.bidderNumber}` : null),
      customerId: null,
      customerMatch: "NONE",
      action: "SKIP",
      messages: [...r.notes],
      purchaseId: null,
    };
    results.push(res);
    if (r.errors.length) {
      res.action = "ERROR";
      res.messages.push(...r.errors);
      continue;
    }
    const lot = (r.externalLotId && byExternal.get(r.externalLotId)) || (r.lotNumber !== null ? byNumber.get(r.lotNumber) : undefined);
    if (!lot) {
      res.action = "ERROR";
      res.messages.push("הלוט לא נמצא בקטלוג (ההתאמה היא לפי מספר לוט או מזהה חיצוני בלבד, לא לפי שם הספר)");
      continue;
    }
    res.lotId = lot.id;
    res.lotNumber = lot.lotNumber;
    if (seenLots.has(lot.id)) {
      res.action = "ERROR";
      res.messages.push(`הלוט מופיע יותר מפעם אחת בקובץ`);
      continue;
    }
    seenLots.add(lot.id);

    const active = await tx.purchase.findFirst({ where: { lotId: lot.id, status: "ACTIVE" }, include: { order: { include: { payments: { where: { status: "RECORDED" }, take: 1 } } } } });

    if (r.outcome === "UNKNOWN") {
      res.action = "SKIP";
      continue;
    }
    if (r.outcome === "UNSOLD") {
      if (active) {
        res.action = "CONFLICT";
        res.messages.push("הלוט רשום כנמכר במערכת ובקובץ הוא מופיע כלא נמכר. לא שונה - יש לטפל בעסקה ידנית");
      } else if (lot.commercialStatus === "UNSOLD") {
        res.action = "UNCHANGED";
      } else if (lot.assignmentStatus === "ACTIVE" && (lot.commercialStatus === "ASSIGNED" || lot.commercialStatus === "OFFERED")) {
        // not sold at the auction. The lot STAYS in the sale until "סיום מכירה" decides what happens to it
        await tx.lot.update({ where: { id: lot.id }, data: { commercialStatus: "UNSOLD" } });
        for (const itemId of await memberItemIds(lot.id, tx)) await syncItemCommercial(tx, user, itemId, { reason: "לא נמכר במכרז", refId: lot.id });
        await tx.saleEvent.create({ data: { organizationId: user.organizationId, catalogId: imp.catalogId, kind: "UNSOLD_AT_AUCTION", data: asJson({ lotId: lot.id, lotNumber: lot.lotNumber, importId: imp.id }), userId: user.userId } });
        res.action = "UPDATE";
      } else {
        res.action = "SKIP";
        res.messages.push("מצב הלוט במערכת אינו מאפשר סימון כלא נמכר");
      }
      continue;
    }

    // ───── SOLD ─────
    const m = await matchCustomer(tx, user.organizationId, { buyerId: r.buyerId, bidderNumber: r.bidderNumber, catalogId: imp.catalogId, email: r.email, phone: r.phone });
    let customerId: string | null = null;
    if (m.kind === "AMBIGUOUS") {
      res.customerMatch = "AMBIGUOUS";
      res.action = "CONFLICT";
      res.messages.push(`לא ברור מי הלקוח: ${m.reason}. יש לטפל ידנית (מיזוג או תיקון הנתונים)`);
      continue;
    }
    if (m.kind === "EXISTING") {
      customerId = m.customerId;
      res.customerMatch = "EXISTING";
      const c = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      // safe update: fill what is empty, never overwrite
      const fill: Prisma.CustomerUpdateInput = {};
      if (!c.email && normEmail(r.email)) Object.assign(fill, { email: r.email, emailNorm: normEmail(r.email) });
      if (!c.phone && normPhone(r.phone)) Object.assign(fill, { phone: r.phone, phoneNorm: normPhone(r.phone) });
      if ((c.addresses as Address[]).length === 0 && r.address) fill.addresses = asJson(addressFrom(r.address));
      if (Object.keys(fill).length) await tx.customer.update({ where: { id: customerId }, data: fill });
      if (r.buyerName && r.buyerName.trim().toLowerCase() !== c.name.trim().toLowerCase()) res.messages.push(`השם בקובץ ("${r.buyerName}") שונה מהשם במערכת ("${c.name}") - לא עודכן`);
      await attachIdentities(tx, user.organizationId, customerId, { buyerId: r.buyerId, bidderNumber: r.bidderNumber, catalogId: imp.catalogId });
      // a customer created earlier in this same file is not an "existing" one
    } else {
      const hasContact = !!(normEmail(r.email) || normPhone(r.phone));
      const hasId = !!(r.buyerId || r.bidderNumber);
      if (!r.buyerName && !hasId && !hasContact) {
        res.action = "ERROR";
        res.messages.push("אין מספיק פרטי זיהוי של הקונה (שם, אימייל, טלפון או מזהה)");
        continue;
      }
      if (!hasContact && !hasId) {
        // a name alone never identifies a person
        res.action = "ERROR";
        res.messages.push("שם בלבד אינו מספיק לזיהוי קונה. חסרים אימייל, טלפון או מזהה");
        continue;
      }
      const incomplete = !r.buyerName || (!hasContact && !r.buyerId);
      const c = await createCustomerTx(
        tx,
        user,
        { name: r.buyerName ?? `מציע ${r.bidderNumber ?? r.buyerId}`, email: normEmail(r.email) ? r.email : null, phone: normPhone(r.phone) ? r.phone : null, addresses: addressFrom(r.address), needsDetails: incomplete },
        { buyerId: r.buyerId, bidderNumber: r.bidderNumber, catalogId: imp.catalogId },
      );
      customerId = c.id;
      res.customerMatch = incomplete ? "NEEDS_DETAILS" : "NEW";
      if (incomplete) needsDetails.add(c.id);
      else newCustomers.add(c.id);
      await tx.saleEvent.create({ data: { organizationId: user.organizationId, customerId: c.id, catalogId: imp.catalogId, kind: "CUSTOMER_CREATED", data: asJson({ importId: imp.id, incomplete }), userId: user.userId } });
    }
    res.customerId = customerId;
    buyers.add(customerId);
    if (res.customerMatch === "EXISTING" && !newCustomers.has(customerId) && !needsDetails.has(customerId)) existingCustomers.add(customerId);

    if (r.transactionId) {
      const dup = await tx.purchase.findFirst({ where: { organizationId: user.organizationId, externalTransactionId: r.transactionId, lotId: { not: lot.id } } });
      if (dup) {
        res.action = "ERROR";
        res.messages.push("מזהה העסקה כבר קיים ברכישה של לוט אחר");
        continue;
      }
    }

    if (active) {
      res.purchaseId = active.id;
      const manual = (active.manualFields as string[]) ?? [];
      const sameBuyer = active.customerId === customerId;
      const samePrice = active.hammerPrice?.toFixed(2) === r.hammerPrice;
      if (sameBuyer && samePrice) {
        res.action = "UNCHANGED";
        continue;
      }
      const locked = manual.length > 0 || !!active.releasedAt || !!active.order?.payments.length || !!(await tx.shipmentItem.count({ where: { purchaseId: active.id } }));
      if (locked) {
        res.action = "CONFLICT";
        res.messages.push(
          `הקובץ שונה ממה שנרשם${!sameBuyer ? " (קונה)" : ""}${!samePrice ? ` (מחיר פטיש: ${active.hammerPrice?.toFixed(2)} ← ${r.hammerPrice})` : ""}, אבל אחרי הקליטה הקודמת בוצעו תיקון ידני, תשלום, שחרור או משלוח. לא שונה`,
        );
        continue;
      }
      const order = await tx.buyerOrder.upsert({
        where: { catalogId_customerId: { catalogId: imp.catalogId, customerId } },
        create: { organizationId: user.organizationId, catalogId: imp.catalogId, customerId, externalOrderId: r.orderNumber },
        update: {},
      });
      await tx.purchase.update({
        where: { id: active.id },
        data: { customerId, orderId: order.id, hammerPrice: new Prisma.Decimal(r.hammerPrice!), buyerPremium: r.buyerPremium ? new Prisma.Decimal(r.buyerPremium) : active.buyerPremium, tax: r.tax ? new Prisma.Decimal(r.tax) : active.tax, bidderNumber: r.bidderNumber ?? active.bidderNumber, importId: imp.id },
      });
      await tx.saleEvent.create({ data: { organizationId: user.organizationId, purchaseId: active.id, customerId, catalogId: imp.catalogId, kind: "IMPORT_CHANGED", data: asJson({ before: { customerId: active.customerId, hammerPrice: active.hammerPrice?.toFixed(2) }, after: { customerId, hammerPrice: r.hammerPrice }, importId: imp.id }), userId: user.userId } });
      res.action = "UPDATE";
      res.messages.push("נתוני הרכישה עודכנו לפי הקובץ המתוקן");
      continue;
    }

    try {
      const p = await recordSaleTx(tx, user, {
        lotId: lot.id,
        customerId,
        hammerPrice: r.hammerPrice!,
        buyerPremium: r.buyerPremium,
        tax: r.tax,
        source: "IMPORT",
        bidderNumber: r.bidderNumber,
        externalTransactionId: r.transactionId,
        orderExternalId: r.orderNumber,
        importId: imp.id,
      });
      res.purchaseId = p.id;
      res.action = "CREATE";
    } catch (e) {
      // a lot that cannot be sold in its present state is reported, the rest of the file goes on
      if (!(e instanceof AppError)) throw e;
      res.action = "CONFLICT";
      res.messages.push(e.message);
    }
  }

  const count = (f: (r: RowResult) => boolean) => results.filter(f).length;
  const summary: ImportSummary = {
    rowsInFile: rows.length,
    sold: count((r) => r.outcome === "SOLD"),
    unsold: count((r) => r.outcome === "UNSOLD"),
    unknown: count((r) => r.outcome === "UNKNOWN"),
    hammerTotal: addMoney(...results.filter((r) => r.outcome === "SOLD" && r.hammerPrice && !["ERROR", "SKIP"].includes(r.action)).map((r) => r.hammerPrice)),
    buyers: buyers.size,
    newCustomers: newCustomers.size,
    existingCustomers: existingCustomers.size,
    needsDetails: needsDetails.size,
    ambiguous: count((r) => r.customerMatch === "AMBIGUOUS"),
    created: count((r) => r.action === "CREATE"),
    updated: count((r) => r.action === "UPDATE"),
    unchanged: count((r) => r.action === "UNCHANGED"),
    conflicts: count((r) => r.action === "CONFLICT"),
    errors: count((r) => r.action === "ERROR"),
    skipped: count((r) => r.action === "SKIP"),
    lotsNotInFile: lots.filter((l) => l.assignmentStatus === "ACTIVE" && !seenLots.has(l.id)).length,
  };
  return { rows: results, summary };
}

async function run(user: UserPrincipal, importId: string, commit: boolean, mapping?: ImportMapping) {
  const imp = await db.saleResultImport.findFirst({ where: { id: importId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!imp) throw notFound("הייבוא");
  assertHouse(user, imp.catalog.auctionHouseId);
  if (imp.status === "COMMITTED") throw new AppError("CONFLICT", "הייבוא כבר נקלט");
  if (imp.status === "DISCARDED") throw new AppError("CONFLICT", "הייבוא בוטל");
  const map = mapping ?? (mappingSchema.parse(imp.mapping) as ImportMapping);
  if (!map.results.lotNumber && !map.results.externalLotId) throw new AppError("VALIDATION", "יש לבחור עמודה של מספר לוט או מזהה לוט חיצוני");
  const files = await loadFiles(imp);
  const rows = normalizeRows(files.file, map, files.buyers);

  let outcome: { rows: RowResult[]; summary: ImportSummary };
  try {
    outcome = await db.$transaction(
      async (tx) => {
        // one import at a time per sale: the same lots / customers must not be written by two files together
        await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${imp.catalogId}::uuid FOR UPDATE`;
        const r = await applyRows(tx, user, imp, rows);
        if (!commit) throw new Rollback(r);
        await tx.saleResultImportRow.deleteMany({ where: { importId } });
        await tx.saleResultImportRow.createMany({
          data: r.rows.map((x, i) => ({
            importId,
            rowIndex: x.rowIndex,
            raw: asJson(files.file.rows[x.rowIndex - 2] ?? {}),
            normalized: asJson(rows[i]!),
            lotId: x.lotId,
            outcome: x.outcome,
            hammerPrice: x.hammerPrice ? new Prisma.Decimal(x.hammerPrice) : null,
            customerId: x.customerId,
            customerMatch: x.customerMatch,
            action: x.action,
            messages: asJson(x.messages),
            purchaseId: x.purchaseId,
          })),
        });
        await tx.saleResultImport.update({ where: { id: importId }, data: { status: "COMMITTED", committedAt: new Date(), committedById: user.userId, summary: asJson(r.summary), mapping: asJson(map) } });
        await tx.saleEvent.create({ data: { organizationId: user.organizationId, catalogId: imp.catalogId, kind: "IMPORT_COMMITTED", data: asJson({ importId, fileName: imp.fileName, ...r.summary }), userId: user.userId } });
        await audit(user, { action: "sales.import_committed", entityType: "catalog", entityId: imp.catalogId, data: asJson({ importId, ...r.summary }) }, tx);
        return r;
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    outcome = e.payload;
  }
  return outcome;
}

/** Shows what the commit would do with this (possibly corrected) mapping. Changes nothing except the saved mapping. */
export async function previewImport(user: UserPrincipal, importId: string, mapping?: ImportMapping) {
  if (mapping) {
    const imp = await db.saleResultImport.findFirst({ where: { id: importId, organizationId: user.organizationId } });
    if (!imp) throw notFound("הייבוא");
    await db.saleResultImport.update({ where: { id: importId }, data: { mapping: asJson(mapping) } });
  }
  const r = await run(user, importId, false, mapping);
  await db.saleResultImport.update({ where: { id: importId }, data: { summary: asJson(r.summary) } });
  return r;
}

export async function commitImport(user: UserPrincipal, importId: string) {
  return run(user, importId, true);
}

export async function discardImport(user: UserPrincipal, importId: string) {
  const r = await db.saleResultImport.updateMany({ where: { id: importId, organizationId: user.organizationId, status: "PREVIEW" }, data: { status: "DISCARDED" } });
  if (!r.count) throw new AppError("CONFLICT", "לא ניתן לבטל ייבוא שכבר נקלט");
}

export async function saveTemplate(user: UserPrincipal, name: string, kind: "RESULTS" | "BUYERS", mapping: ImportMapping) {
  const n = name.trim();
  if (!n) throw new AppError("VALIDATION", "יש לתת שם לתבנית");
  return db.saleImportTemplate.upsert({
    where: { organizationId_kind_name: { organizationId: user.organizationId, kind, name: n } },
    create: { organizationId: user.organizationId, kind, name: n, mapping: asJson(mapping), createdById: user.userId },
    update: { mapping: asJson(mapping) },
  });
}

export async function listTemplates(orgId: string) {
  return db.saleImportTemplate.findMany({ where: { organizationId: orgId }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } });
}

export async function listImports(user: UserPrincipal, catalogId: string) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const rows = await db.saleResultImport.findMany({ where: { catalogId }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map((i) => ({ id: i.id, fileName: i.fileName, status: i.status, createdAt: i.createdAt.toISOString(), committedAt: i.committedAt?.toISOString() ?? null, summary: i.summary as ImportSummary | null }));
}
