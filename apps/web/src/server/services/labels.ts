import "server-only";
import { db } from "../db";
import { locationInclude, locationLabel } from "./location-label";

/*
 * Labels. Antique books never get adhesive labels on the binding: the book
 * tag goes on the protective sleeve / box / a hanging tag (see the warning on
 * the print screen). Two kinds:
 *   book tag     — inventory number, Code 128, short title, optional QR
 *   location tag — location code, zone/shelf, large Code 128
 * Output: print-ready HTML (→ printer or "Save as PDF") and ZPL for thermal printers.
 */

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}
export const LABEL_SIZES: Record<string, LabelSize> = {
  "50x25": { widthMm: 50, heightMm: 25 },
  "57x32": { widthMm: 57, heightMm: 32 },
  "70x40": { widthMm: 70, heightMm: 40 },
  "100x50": { widthMm: 100, heightMm: 50 },
};
export function labelSize(key: string | null | undefined): LabelSize {
  return LABEL_SIZES[key ?? ""] ?? LABEL_SIZES["50x25"]!;
}

export interface BookLabel {
  id: string;
  code: string;
  title: string;
  subtitle: string | null;
}
export interface LocationLabel {
  id: string;
  code: string;
  zone: string;
  shelf: string;
  cell: string;
  label: string;
}

export async function bookLabels(orgId: string, ids: string[]): Promise<BookLabel[]> {
  const items = await db.inventoryItem.findMany({ where: { organizationId: orgId, id: { in: ids } }, orderBy: { serial: "asc" } });
  return items.map((i) => ({ id: i.id, code: i.barcode, title: i.title, subtitle: i.author }));
}

export async function locationLabels(orgId: string, ids: string[]): Promise<LocationLabel[]> {
  const locs = await db.storageLocation.findMany({ where: { organizationId: orgId, id: { in: ids } }, include: locationInclude, orderBy: { sortKey: "asc" } });
  return locs.map((l) => ({ id: l.id, code: l.code, zone: l.shelf.zone.name, shelf: l.shelf.code, cell: l.cell, label: locationLabel(l) }));
}

/** 8 dots/mm (203 dpi), the common thermal-printer resolution. */
const DOTS = 8;
const dots = (mm: number) => Math.round(mm * DOTS);

/** Hex-escape indicator for ^FH: a backslash (built from its char code to keep the source unambiguous). */
const BACKSLASH = String.fromCharCode(92);
const FH = `^FH${BACKSLASH}`;

/** Escapes ZPL field data: ^, ~ and the backslash itself become hex escapes (\5e, \7e, \5c). */
function fd(text: string) {
  return text.replace(/[\^~\\]/g, (c) => `${BACKSLASH}${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * ZPL II for book and location tags. Hebrew text needs a Unicode font on the
 * printer (^CI28 = UTF-8; ^A@ selects the font stored as E:ARIAL.TTF here —
 * adjust FONT to what the printer has). Codes are plain ASCII and always print.
 */
export function toZpl(opts: { books?: BookLabel[]; locations?: LocationLabel[]; size: LabelSize; font?: string }): string {
  const font = opts.font ?? "E:ARIAL.TTF";
  const w = dots(opts.size.widthMm);
  const h = dots(opts.size.heightMm);
  const m = dots(2);
  const out: string[] = [];
  for (const b of opts.books ?? []) {
    const barH = Math.round(h * 0.42);
    out.push(
      [
        "^XA",
        "^CI28",
        `^PW${w}`,
        `^LL${h}`,
        `^FO${m},${m}^BY2,3,${barH}^BCN,${barH},N,N,N${FH}^FD${fd(b.code)}^FS`,
        `^FO${m},${m + barH + dots(1)}^A0N,${dots(3.2)},${dots(3.2)}${FH}^FD${fd(b.code)}^FS`,
        `^FO${m},${m + barH + dots(5)}^FB${w - 2 * m},1,0,R^A@N,${dots(3)},${dots(3)},${font}${FH}^FD${fd(truncate(b.title, 40))}^FS`,
        "^XZ",
      ].join("\n"),
    );
  }
  for (const l of opts.locations ?? []) {
    const barH = Math.round(h * 0.5);
    out.push(
      [
        "^XA",
        "^CI28",
        `^PW${w}`,
        `^LL${h}`,
        `^FO${m},${m}^A0N,${dots(5)},${dots(5)}${FH}^FD${fd(l.code)}^FS`,
        `^FO${m},${m + dots(6)}^BY2,3,${barH}^BCN,${barH},N,N,N${FH}^FD${fd(l.code)}^FS`,
        `^FO${m},${m + dots(7) + barH}^FB${w - 2 * m},1,0,R^A@N,${dots(3)},${dots(3)},${font}${FH}^FD${fd(truncate(l.label, 48))}^FS`,
        "^XZ",
      ].join("\n"),
    );
  }
  return out.join("\n") + "\n";
}
