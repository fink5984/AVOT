import "server-only";
import { asJson } from "../json";
import Papa from "papaparse";
import { DEFAULT_REQUIREMENTS, type CategoryRequirements } from "@avot/shared";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { createItemTx } from "./inventory";
import { syncItemCommercial } from "./assignments";

/** Accepted column headers (English keys or Hebrew labels) → field. */
const HEADER_MAP: Record<string, string> = {
  lot_number: "lotNumber", "מספר": "lotNumber", "מספר פריט": "lotNumber", lot: "lotNumber",
  title: "title", "שם": "title", "שם ספר": "title", "כותר": "title",
  subtitle: "subtitle", "כותרת משנה": "subtitle",
  author: "author", "מחבר": "author",
  print_year: "printYear", "שנת דפוס": "printYear", "שנה": "printYear",
  print_place: "printPlace", "מקום דפוס": "printPlace", "מקום": "printPlace",
  short_description: "shortDescription", "תיאור": "shortDescription", "תיאור קצר": "shortDescription",
  internal_notes: "internalNotes", "הערות": "internalNotes", "הערות פנימיות": "internalNotes",
  publisher: "publisher", "הוצאה": "publisher", "מו״ל": "publisher",
  condition: "conditionNotes", "מצב": "conditionNotes", "מצב פיזי": "conditionNotes",
  height_mm: "heightMm", "גובה": "heightMm", "גובה (מ״מ)": "heightMm",
  width_mm: "widthMm", "רוחב": "widthMm", "רוחב (מ״מ)": "widthMm",
  depth_mm: "depthMm", "עובי": "depthMm", "עובי (מ״מ)": "depthMm",
  barcode: "barcode", "ברקוד": "barcode",
};

export interface ImportRow {
  line: number;
  lotNumber?: number;
  title: string;
  subtitle?: string;
  author?: string;
  printYear?: string;
  printPlace?: string;
  shortDescription?: string;
  internalNotes?: string;
  publisher?: string;
  conditionNotes?: string;
  heightMm?: number;
  widthMm?: number;
  depthMm?: number;
  barcode?: string;
}

export interface ImportPreview {
  rows: ImportRow[];
  errors: { line: number; message: string }[];
  unknownColumns: string[];
}

export function parseLotsCsv(text: string): ImportPreview {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = parsed.meta.fields ?? [];
  const unknownColumns = headers.filter((h) => !HEADER_MAP[h.trim().toLowerCase()] && !HEADER_MAP[h.trim()]);
  const errors: ImportPreview["errors"] = parsed.errors.map((e) => ({ line: (e.row ?? 0) + 2, message: e.message }));
  const rows: ImportRow[] = [];
  const seen = new Set<number>();
  parsed.data.forEach((raw, i) => {
    const line = i + 2;
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const field = HEADER_MAP[k.trim().toLowerCase()] ?? HEADER_MAP[k.trim()];
      if (field && typeof v === "string" && v.trim()) r[field] = v.trim();
    }
    if (!r.title) {
      errors.push({ line, message: "חסר שם ספר" });
      return;
    }
    let lotNumber: number | undefined;
    if (r.lotNumber) {
      lotNumber = Number(r.lotNumber);
      if (!Number.isInteger(lotNumber) || lotNumber < 1) {
        errors.push({ line, message: `מספר פריט לא תקין: ${r.lotNumber}` });
        return;
      }
      if (seen.has(lotNumber)) {
        errors.push({ line, message: `מספר פריט ${lotNumber} מופיע יותר מפעם אחת בקובץ` });
        return;
      }
      seen.add(lotNumber);
    }
    if (r.title.length > 300) {
      errors.push({ line, message: "שם הספר ארוך מ-300 תווים" });
      return;
    }
    const mm: Partial<Record<"heightMm" | "widthMm" | "depthMm", number>> = {};
    for (const k of ["heightMm", "widthMm", "depthMm"] as const) {
      if (!r[k]) continue;
      const n = Number(r[k]);
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        errors.push({ line, message: `מידה לא תקינה (מ"מ): ${r[k]}` });
        return;
      }
      mm[k] = n;
    }
    if (r.barcode && !/^[\x21-\x7e]{3,64}$/.test(r.barcode)) {
      errors.push({ line, message: `ברקוד לא תקין: ${r.barcode}` });
      return;
    }
    rows.push({
      line,
      lotNumber,
      title: r.title,
      subtitle: r.subtitle,
      author: r.author,
      printYear: r.printYear,
      printPlace: r.printPlace,
      shortDescription: r.shortDescription,
      internalNotes: r.internalNotes,
      publisher: r.publisher,
      conditionNotes: r.conditionNotes,
      barcode: r.barcode,
      ...mm,
    });
  });
  return { rows, errors, unknownColumns };
}

function itemFields(r: ImportRow) {
  return {
    title: r.title,
    subtitle: r.subtitle ?? null,
    author: r.author ?? null,
    printYear: r.printYear ?? null,
    printPlace: r.printPlace ?? null,
    internalNotes: r.internalNotes ?? null,
    publisher: r.publisher ?? null,
    conditionNotes: r.conditionNotes ?? null,
    heightMm: r.heightMm ?? null,
    widthMm: r.widthMm ?? null,
    depthMm: r.depthMm ?? null,
    barcode: r.barcode,
  };
}

async function checkBarcodes(orgId: string, preview: ImportPreview) {
  const codes = preview.rows.map((r) => r.barcode).filter((b): b is string => !!b);
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  for (const r of preview.rows) if (r.barcode && dup.includes(r.barcode)) preview.errors.push({ line: r.line, message: `ברקוד ${r.barcode} מופיע יותר מפעם אחת בקובץ` });
  if (!codes.length) return;
  const taken = await db.inventoryItem.findMany({
    where: { organizationId: orgId, OR: [{ barcode: { in: codes } }, { inventoryNumber: { in: codes } }] },
    select: { barcode: true, inventoryNumber: true },
  });
  for (const r of preview.rows) {
    const t = taken.find((x) => x.barcode === r.barcode || x.inventoryNumber === r.barcode);
    if (t) preview.errors.push({ line: r.line, message: `ברקוד ${r.barcode} כבר משויך לספר ${t.inventoryNumber}` });
  }
}

/**
 * All-or-nothing import into a catalog: every row is a new book received into
 * inventory and assigned to the catalog. Rows without a number get the next
 * free numbers in file order.
 */
export async function importLots(user: UserPrincipal, catalogId: string, text: string, dryRun: boolean) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const preview = parseLotsCsv(text);
  if (preview.rows.length > 2000) throw new AppError("VALIDATION", "ניתן לייבא עד 2000 פריטים בקובץ אחד");

  const existing = await db.lot.findMany({ where: { catalogId }, select: { lotNumber: true } });
  const taken = new Set(existing.map((l) => l.lotNumber));
  for (const r of preview.rows) {
    if (r.lotNumber && taken.has(r.lotNumber)) preview.errors.push({ line: r.line, message: `פריט מספר ${r.lotNumber} כבר קיים בקטלוג` });
  }
  await checkBarcodes(user.organizationId, preview);
  if (dryRun || preview.errors.length) return { ...preview, imported: 0 };

  const requirements = (catalog.defaultRequirements ?? DEFAULT_REQUIREMENTS) as unknown as CategoryRequirements;
  const imported = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Catalog" WHERE id = ${catalogId}::uuid FOR UPDATE`;
      const agg = await tx.lot.aggregate({ where: { catalogId }, _max: { lotNumber: true, sortOrder: true } });
      let nextNumber = (agg._max.lotNumber ?? 0) + 1;
      let sort = agg._max.sortOrder ?? 0;
      const used = new Set([...taken, ...preview.rows.map((r) => r.lotNumber).filter((n): n is number => !!n)]);
      for (const r of preview.rows) {
        let lotNumber = r.lotNumber;
        if (!lotNumber) {
          while (used.has(nextNumber)) nextNumber++;
          lotNumber = nextNumber;
          used.add(lotNumber);
        }
        const item = await createItemTx(tx, user, itemFields(r), { requirements });
        const lot = await tx.lot.create({
          data: {
            organizationId: user.organizationId,
            catalogId,
            inventoryItemId: item.id,
            lotNumber,
            sortOrder: ++sort,
            title: r.title,
            subtitle: r.subtitle ?? null,
            author: r.author ?? null,
            printYear: r.printYear ?? null,
            printPlace: r.printPlace ?? null,
            shortDescription: r.shortDescription ?? null,
            internalNotes: r.internalNotes ?? null,
            requirements: asJson(requirements),
            assignedById: user.userId,
          },
        });
        await tx.lotDescriptionVersion.create({
          data: { lotId: lot.id, version: 1, title: lot.title, shortDescription: lot.shortDescription, source: "IMPORT", createdById: user.userId },
        });
        await syncItemCommercial(tx, user, item.id, { reason: `ייבוא CSV לקטלוג ${catalog.number}`, refId: lot.id });
      }
      return preview.rows.length;
    },
    { timeout: 180_000 },
  );
  await audit(user, { action: "lot.imported_csv", entityType: "catalog", entityId: catalogId, data: { count: imported } });
  return { ...preview, imported };
}

/** All-or-nothing import of books into inventory only (no catalog). Lot numbers in the file are ignored. */
export async function importItems(user: UserPrincipal, text: string, dryRun: boolean) {
  const preview = parseLotsCsv(text);
  if (preview.rows.length > 2000) throw new AppError("VALIDATION", "ניתן לייבא עד 2000 ספרים בקובץ אחד");
  await checkBarcodes(user.organizationId, preview);
  if (dryRun || preview.errors.length) return { ...preview, imported: 0 };
  const imported = await db.$transaction(
    async (tx) => {
      for (const r of preview.rows) await createItemTx(tx, user, itemFields(r));
      return preview.rows.length;
    },
    { timeout: 180_000 },
  );
  await audit(user, { action: "inventory.imported_csv", entityType: "inventory", data: { count: imported } });
  return { ...preview, imported };
}
