import "server-only";
import { code128Modules } from "@/lib/barcode/code128";
import { renderTextBitmap, toGraphicField } from "./bitmap";

/*
 * Label layouts for thermal printers (ZPL II). Everything printed is either ASCII drawn by the printer
 * (the Code 128 symbol and the readable number) or a bitmap drawn on the server (Hebrew). The Code 128
 * symbol is the printer's native ^BC — it encodes exactly the stored InventoryItem.barcode / location code.
 */

export interface LabelStock {
  widthMm: number;
  heightMm: number;
}
export const LABEL_STOCKS: Record<string, LabelStock> = {
  "50x25": { widthMm: 50, heightMm: 25 },
  "57x32": { widthMm: 57, heightMm: 32 },
  "70x40": { widthMm: 70, heightMm: 40 },
  "100x50": { widthMm: 100, heightMm: 50 },
};
export function labelStock(key: string | null | undefined): LabelStock {
  return LABEL_STOCKS[key ?? ""] ?? LABEL_STOCKS["57x32"]!;
}

export type PrintLabel =
  | { type: "BOOK"; code: string; inventoryNumber: string; title: string }
  | { type: "LOCATION"; code: string; path: string; shelf: string }
  | { type: "ZONE"; code: string; name: string; warehouse: string }
  | { type: "TEST"; text: string };

const BACKSLASH = String.fromCharCode(92);
const FH = `^FH${BACKSLASH}`;
/** ^, ~ and the backslash become hex escapes inside ^FD data */
const fd = (t: string) => t.replace(/[\^~\\]/g, (c) => `${BACKSLASH}${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const ascii = (t: string) => t.replace(/[^\x20-\x7e]/g, "?");

/** module width (dots) for a Code 128 symbol that must fit `avail` dots */
export function barcodeModuleWidth(code: string, avail: number, max = 3): { by: number; widthDots: number } {
  const modules = code128Modules(code).reduce((a, b) => a + b, 0);
  let by = max;
  while (by > 1 && modules * by > avail) by--;
  return { by, widthDots: modules * by };
}

interface Geometry {
  w: number;
  h: number;
  margin: number;
  dpm: number;
}
function geometry(stock: LabelStock, dotsPerMm: number): Geometry {
  return { w: Math.round(stock.widthMm * dotsPerMm), h: Math.round(stock.heightMm * dotsPerMm), margin: Math.round(2 * dotsPerMm), dpm: dotsPerMm };
}

function head(g: Geometry) {
  // ^CI28 = UTF-8, ^PW/^LL = media size, ^LH origin, ^PR slow enough for crisp bars
  return ["^XA", "^CI28", `^PW${g.w}`, `^LL${g.h}`, "^LH0,0", "^PR3"];
}

function barcodeField(g: Geometry, code: string, y: number, barH: number) {
  const { by, widthDots } = barcodeModuleWidth(code, g.w - 2 * g.margin, Math.max(2, Math.round(g.dpm / 4)));
  const x = Math.max(g.margin, Math.round((g.w - widthDots) / 2));
  return `^FO${x},${y}^BY${by},3,${barH}^BCN,${barH},N,N,N${FH}^FD${fd(ascii(code))}^FS`;
}

function readable(g: Geometry, text: string, y: number) {
  const px = Math.round(g.dpm * 3);
  return `^FO${g.margin},${y}^FB${g.w - 2 * g.margin},1,0,C^A0N,${px},${px}${FH}^FD${fd(ascii(text))}^FS`;
}

async function bookLabel(g: Geometry, l: Extract<PrintLabel, { type: "BOOK" }>) {
  const textW = g.w - 2 * g.margin;
  const title = await renderTextBitmap(l.title, { width: textW, maxHeight: Math.round(g.h * 0.36), fontPx: Math.round(g.dpm * 3.6), bold: true });
  const barY = g.margin + title.height + Math.round(g.dpm * 1.2);
  const numPx = Math.round(g.dpm * 3);
  const barH = Math.max(Math.round(g.dpm * 6), g.h - barY - numPx - g.margin - Math.round(g.dpm * 1.5));
  return [
    ...head(g),
    `^FO${g.margin},${g.margin}${toGraphicField(title)}^FS`,
    barcodeField(g, l.code, barY, barH),
    readable(g, l.inventoryNumber, barY + barH + Math.round(g.dpm)),
    "^XZ",
  ];
}

async function locationLabel(g: Geometry, l: Extract<PrintLabel, { type: "LOCATION" }>) {
  const textW = g.w - 2 * g.margin;
  const big = await renderTextBitmap(l.shelf, { width: textW, maxHeight: Math.round(g.h * 0.3), fontPx: Math.round(g.dpm * 5.5), bold: true });
  const path = await renderTextBitmap(l.path, { width: textW, maxHeight: Math.round(g.h * 0.2), fontPx: Math.round(g.dpm * 3), minFontPx: Math.round(g.dpm * 2) });
  const barY = g.margin + big.height + path.height + Math.round(g.dpm * 2);
  const codePx = Math.round(g.dpm * 3);
  const barH = Math.max(Math.round(g.dpm * 6), g.h - barY - codePx - g.margin - Math.round(g.dpm * 1.5));
  return [
    ...head(g),
    `^FO${g.margin},${g.margin}${toGraphicField(big)}^FS`,
    `^FO${g.margin},${g.margin + big.height + Math.round(g.dpm / 2)}${toGraphicField(path)}^FS`,
    barcodeField(g, l.code, barY, barH),
    readable(g, l.code, barY + barH + Math.round(g.dpm)),
    "^XZ",
  ];
}

async function zoneLabel(g: Geometry, l: Extract<PrintLabel, { type: "ZONE" }>) {
  const textW = g.w - 2 * g.margin;
  const name = await renderTextBitmap(l.name, { width: textW, maxHeight: Math.round(g.h * 0.45), fontPx: Math.round(g.dpm * 9), bold: true, align: "centre" });
  const wh = await renderTextBitmap(l.warehouse, { width: textW, maxHeight: Math.round(g.h * 0.18), fontPx: Math.round(g.dpm * 3.4), align: "centre" });
  const barY = g.margin + name.height + wh.height + Math.round(g.dpm * 2);
  const codePx = Math.round(g.dpm * 3);
  const barH = Math.max(Math.round(g.dpm * 5), g.h - barY - codePx - g.margin - Math.round(g.dpm * 1.5));
  return [
    ...head(g),
    `^FO${g.margin},${g.margin}${toGraphicField(name)}^FS`,
    `^FO${g.margin},${g.margin + name.height + Math.round(g.dpm / 2)}${toGraphicField(wh)}^FS`,
    barcodeField(g, l.code, barY, barH),
    readable(g, l.code, barY + barH + Math.round(g.dpm)),
    "^XZ",
  ];
}

async function testLabel(g: Geometry, l: Extract<PrintLabel, { type: "TEST" }>) {
  const textW = g.w - 2 * g.margin;
  const t = await renderTextBitmap(l.text, { width: textW, maxHeight: Math.round(g.h * 0.5), fontPx: Math.round(g.dpm * 4.5), bold: true });
  const barY = g.margin + t.height + Math.round(g.dpm * 2);
  const barH = Math.max(Math.round(g.dpm * 5), g.h - barY - g.margin);
  return [...head(g), `^FO${g.margin},${g.margin}${toGraphicField(t)}^FS`, barcodeField(g, "AVOT-TEST", barY, barH), "^XZ"];
}

/** ZPL for the labels, each repeated `copies` times (one format per physical label). */
export async function renderZpl(labels: PrintLabel[], opts: { stock: LabelStock; dotsPerMm?: number; copies?: number }): Promise<string> {
  const g = geometry(opts.stock, opts.dotsPerMm ?? 8);
  const copies = Math.min(Math.max(opts.copies ?? 1, 1), 50);
  const out: string[] = [];
  for (const l of labels) {
    const lines =
      l.type === "BOOK" ? await bookLabel(g, l) : l.type === "LOCATION" ? await locationLabel(g, l) : l.type === "ZONE" ? await zoneLabel(g, l) : await testLabel(g, l);
    const block = lines.join("\n");
    for (let i = 0; i < copies; i++) out.push(block);
  }
  return out.join("\n") + "\n";
}
