/**
 * Reading sale-result files (Excel / CSV) into normalised rows. No Bidspirit result file has been seen yet, so nothing
 * here assumes a fixed layout: the columns are detected from common names (English and Hebrew), shown to the person for
 * correction, and the corrected mapping can be saved as a template. A future API adapter produces the same NormalizedRow.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { parseUsd } from "@/lib/money";

export const RESULT_FIELDS = [
  "lotNumber",
  "externalLotId",
  "outcome",
  "hammerPrice",
  "bidderNumber",
  "buyerId",
  "buyerName",
  "email",
  "phone",
  "address",
  "orderNumber",
  "transactionId",
  "buyerPremium",
  "tax",
] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export const FIELD_LABEL: Record<ResultField, string> = {
  lotNumber: "מספר לוט",
  externalLotId: "מזהה לוט חיצוני",
  outcome: "מצב מכירה",
  hammerPrice: "מחיר פטיש",
  bidderNumber: "מספר מציע",
  buyerId: "מזהה קונה קבוע",
  buyerName: "שם קונה",
  email: "אימייל",
  phone: "טלפון",
  address: "כתובת",
  orderNumber: "מספר הזמנה",
  transactionId: "מזהה עסקה חיצונית",
  buyerPremium: "עמלת קונה",
  tax: "מס",
};

export interface ImportMapping {
  /** field → the header of the column that holds it */
  results: Partial<Record<ResultField, string>>;
  /** second file with the buyers' details: how its rows link to the result rows, and which column holds what */
  buyers?: { key: "bidderNumber" | "buyerId"; keyHeader: string; columns: Partial<Record<ResultField, string>> };
  /** words (lower case) meaning sold / not sold in the outcome column, added to the built-in ones */
  soldWords?: string[];
  unsoldWords?: string[];
}

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
}

const SYNONYMS: Record<ResultField, string[]> = {
  lotNumber: ["lot", "lotnumber", "lotno", "lotnum", "itemindex", "itemnumber", "itemno", "לוט", "מספרלוט", "מסלוט", "פריט", "מספרפריט", "מסרפריט"],
  externalLotId: ["lotid", "itemid", "externallotid", "externalid", "מזהלוט", "מזהפריט"],
  outcome: ["status", "result", "outcome", "sold", "soldstatus", "מצב", "סטטוס", "תוצאה", "מצבמכירה", "נמכר"],
  hammerPrice: ["hammer", "hammerprice", "price", "finalprice", "soldprice", "winningbid", "sellingprice", "מחיר", "מחירפטיש", "פטיש", "מחירמכירה", "מחיריעד"],
  bidderNumber: ["bidder", "biddernumber", "bidderno", "paddle", "paddlenumber", "מציע", "מספרמציע", "מסמציע"],
  buyerId: ["buyerid", "userid", "customerid", "accountid", "memberid", "מזהקונה", "מזהלקוח", "מזהמשתמש"],
  buyerName: ["name", "buyer", "buyername", "fullname", "customer", "customername", "winner", "שם", "קונה", "שםקונה", "שםהלקוח", "שםמלא"],
  email: ["email", "mail", "emailaddress", "אימייל", "מייל", "דואל", "דואראלקטרוני"],
  phone: ["phone", "mobile", "tel", "telephone", "cell", "phonenumber", "טלפון", "נייד", "פלאפון", "מספרטלפון"],
  address: ["address", "shippingaddress", "כתובת", "כתובתמשלוח"],
  orderNumber: ["order", "ordernumber", "orderid", "invoice", "invoicenumber", "הזמנה", "מספרהזמנה", "חשבונית"],
  transactionId: ["transactionid", "transaction", "txid", "מזהעסקה", "עסקה"],
  buyerPremium: ["premium", "buyerpremium", "commission", "buyerscommission", "עמלה", "עמלתקונה"],
  tax: ["tax", "vat", "מס", "מעמ", "מסערךמוסף"],
};

const squash = (s: string) => s.toLowerCase().replace(/[\s_\-./"'׳״()]/g, "");

/** best guess of which header holds which field; every header is used at most once */
export function detectMapping(headers: string[]): Partial<Record<ResultField, string>> {
  const out: Partial<Record<ResultField, string>> = {};
  const used = new Set<string>();
  const norm = headers.map((h) => ({ h, n: squash(h) }));
  for (const f of RESULT_FIELDS) {
    const hit = norm.find((x) => !used.has(x.h) && SYNONYMS[f].includes(x.n));
    if (hit) {
      out[f] = hit.h;
      used.add(hit.h);
    }
  }
  return out;
}

/* ───────────────────────── reading ───────────────────────── */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
  if (o.richText) return o.richText.map((r) => r.text).join("").trim();
  if (o.result !== undefined) return cellText(o.result);
  if (o.text !== undefined) return cellText(o.text);
  if (o.hyperlink) return o.hyperlink;
  return "";
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 20000;

export function fileKind(fileName: string, buf: Buffer): "XLSX" | "CSV" {
  const n = fileName.toLowerCase();
  // an xlsx is a zip ("PK")
  if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) return "XLSX";
  if (n.endsWith(".csv") || n.endsWith(".txt")) return "CSV";
  throw new Error("סוג הקובץ אינו נתמך. יש להעלות קובץ XLSX או CSV");
}

export async function parseSaleFile(fileName: string, buf: Buffer): Promise<ParsedFile> {
  if (buf.length > MAX_FILE_BYTES) throw new Error("הקובץ גדול מדי (עד 10MB)");
  const kind = fileKind(fileName, buf);
  let grid: string[][] = [];
  if (kind === "XLSX") {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as never);
    } catch {
      throw new Error("לא ניתן לקרוא את קובץ ה-Excel");
    }
    const ws = wb.worksheets.find((w) => w.rowCount > 0);
    if (!ws) throw new Error("הקובץ ריק");
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
      grid.push(cells);
    });
  } else {
    const text = buf.toString("utf8").replace(/^﻿/, "");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    grid = parsed.data.map((r) => r.map((c) => (c ?? "").trim()));
  }
  grid = grid.filter((r) => r.some((c) => c !== ""));
  if (grid.length < 1) throw new Error("הקובץ ריק");
  if (grid.length - 1 > MAX_ROWS) throw new Error(`הקובץ מכיל יותר מ-${MAX_ROWS} שורות`);
  const seen = new Map<string, number>();
  const headers = grid[0]!.map((h, i) => {
    const base = h || `עמודה ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows };
}

/* ───────────────────────── normalising ───────────────────────── */

export interface NormalizedRow {
  /** 1-based row number as in the file (header = row 1) */
  rowIndex: number;
  lotNumber: number | null;
  externalLotId: string | null;
  outcome: "SOLD" | "UNSOLD" | "UNKNOWN";
  hammerPrice: string | null;
  bidderNumber: string | null;
  buyerId: string | null;
  buyerName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  orderNumber: string | null;
  transactionId: string | null;
  buyerPremium: string | null;
  tax: string | null;
  /** problems that make the row unusable */
  errors: string[];
  /** remarks that do not stop the row */
  notes: string[];
}

const SOLD = ["sold", "won", "yes", "true", "1", "נמכר", "כן", "זכה"];
const UNSOLD = ["unsold", "passed", "notsold", "no", "false", "0", "לאנמכר", "לא", "עבר", "ללאמציעים", "unsoldlot"];

function outcomeOf(raw: string, extraSold: string[] = [], extraUnsold: string[] = []): "SOLD" | "UNSOLD" | "UNKNOWN" {
  const n = squash(raw);
  if (!n) return "UNKNOWN";
  if ([...UNSOLD, ...extraUnsold.map(squash)].includes(n)) return "UNSOLD";
  if ([...SOLD, ...extraSold.map(squash)].includes(n)) return "SOLD";
  return "UNKNOWN";
}

const take = (row: Record<string, string>, header?: string) => {
  if (!header) return null;
  const v = (row[header] ?? "").trim();
  return v === "" ? null : v;
};

export function normalizeRows(file: ParsedFile, mapping: ImportMapping, buyersFile?: ParsedFile | null): NormalizedRow[] {
  const m = mapping.results;
  // buyers' details from the second file, looked up by the key column
  const buyersByKey = new Map<string, Record<string, string>>();
  if (buyersFile && mapping.buyers) {
    for (const r of buyersFile.rows) {
      const k = (r[mapping.buyers.keyHeader] ?? "").trim();
      if (k) buyersByKey.set(k, r);
    }
  }
  return file.rows.map((row, i) => {
    const errors: string[] = [];
    const notes: string[] = [];
    const lotRaw = take(row, m.lotNumber);
    let lotNumber: number | null = null;
    if (lotRaw !== null) {
      const n = Number(lotRaw.replace(/[^\d.]/g, ""));
      if (Number.isInteger(n) && n > 0 && /^\s*\d+(\.0+)?\s*$/.test(lotRaw)) lotNumber = n;
      else errors.push(`מספר הלוט "${lotRaw}" אינו תקין`);
    }
    const externalLotId = take(row, m.externalLotId);
    if (lotNumber === null && !externalLotId && !errors.length) errors.push("אין מספר לוט או מזהה לוט חיצוני");

    let hammerPrice: string | null = null;
    const priceRaw = take(row, m.hammerPrice);
    if (priceRaw !== null) {
      try {
        hammerPrice = parseUsd(priceRaw, { allowZero: true });
      } catch (e) {
        errors.push(`מחיר הפטיש "${priceRaw}": ${(e as Error).message}`);
      }
    }
    const pick = (f: ResultField): string | null => {
      const own = take(row, m[f]);
      if (own !== null) return own;
      if (!buyersFile || !mapping.buyers) return null;
      const keyVal = mapping.buyers.key === "bidderNumber" ? take(row, m.bidderNumber) : take(row, m.buyerId);
      const b = keyVal ? buyersByKey.get(keyVal) : undefined;
      return b ? take(b, mapping.buyers.columns[f]) : null;
    };
    let outcome: NormalizedRow["outcome"];
    const outRaw = take(row, m.outcome);
    if (outRaw !== null) {
      outcome = outcomeOf(outRaw, mapping.soldWords, mapping.unsoldWords);
      if (outcome === "UNKNOWN") notes.push(`מצב המכירה "${outRaw}" אינו מזוהה - השורה לא תיקלט`);
    } else {
      // no outcome column: a hammer price means sold; otherwise nothing can be concluded
      outcome = hammerPrice !== null && Number(hammerPrice) > 0 ? "SOLD" : "UNKNOWN";
      if (outcome === "UNKNOWN") notes.push("אין מצב מכירה ואין מחיר פטיש - לא ניתן להסיק אם הלוט נמכר");
    }
    if (outcome === "SOLD" && (hammerPrice === null || Number(hammerPrice) <= 0)) errors.push("לוט שנמכר חייב מחיר פטיש גדול מאפס");
    if (outcome === "UNSOLD" && hammerPrice !== null && Number(hammerPrice) > 0) {
      notes.push("מסומן כלא נמכר אך יש מחיר פטיש - השורה לא תיקלט");
      outcome = "UNKNOWN";
    }
    const money = (f: ResultField) => {
      const v = pick(f);
      if (v === null) return null;
      try {
        return parseUsd(v, { allowZero: true });
      } catch {
        notes.push(`${FIELD_LABEL[f]} "${v}" אינו תקין ולא ייקלט`);
        return null;
      }
    };
    return {
      rowIndex: i + 2,
      lotNumber,
      externalLotId,
      outcome,
      hammerPrice,
      bidderNumber: pick("bidderNumber"),
      buyerId: pick("buyerId"),
      buyerName: pick("buyerName"),
      email: pick("email"),
      phone: pick("phone"),
      address: pick("address"),
      orderNumber: pick("orderNumber"),
      transactionId: pick("transactionId"),
      buyerPremium: money("buyerPremium"),
      tax: money("tax"),
      errors,
      notes,
    };
  });
}
