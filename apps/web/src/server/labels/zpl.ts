import "server-only";
import { LABEL_STOCKS, layoutLabel, resolveProfile, type LabelContent, type LabelLayout, type LabelProfilesOverrides, type LabelType } from "@avot/shared";
import { toGraphicField } from "./bitmap";
import { renderLabel } from "./render";

/*
 * ZPL II for thermal printers. There is NO design in this file: the layout (boxes in mm) comes from layoutLabel() in the
 * shared package, the rasterisation from render.ts, and this module only writes the result as printer commands:
 * Hebrew / text as bitmaps (^GF), the Code 128 as the printer's native ^BC with the stored barcode value.
 */

export interface LabelStock {
  widthMm: number;
  heightMm: number;
}
export { LABEL_STOCKS };
export function labelStock(key: string | null | undefined): LabelStock {
  return LABEL_STOCKS[key ?? ""] ?? LABEL_STOCKS["57x32"]!;
}

export type PrintLabel = LabelContent;

const BACKSLASH = String.fromCharCode(92);
const FH = `^FH${BACKSLASH}`;
/** ^, ~ and the backslash become hex escapes inside ^FD data */
const fd = (t: string) => t.replace(/[\^~\\]/g, (c) => `${BACKSLASH}${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const ascii = (t: string) => t.replace(/[^\x20-\x7e]/g, "?");

/** the layout of one label with the organization's calibration applied */
export function layoutFor(label: LabelContent, stock: LabelStock, overrides?: LabelProfilesOverrides | null): LabelLayout {
  const type: LabelType = label.type === "TEST" ? "BOOK" : label.type;
  return layoutLabel(label, stock, resolveProfile(type, overrides));
}

/** ZPL for the labels, each repeated `copies` times (one format per physical label). */
export async function renderZpl(labels: LabelContent[], opts: { stock: LabelStock; dotsPerMm?: number; copies?: number; profiles?: LabelProfilesOverrides | null }): Promise<string> {
  const dpm = opts.dotsPerMm ?? 8;
  const copies = Math.min(Math.max(opts.copies ?? 1, 1), 50);
  const out: string[] = [];
  for (const l of labels) {
    const r = await renderLabel(layoutFor(l, opts.stock, opts.profiles), dpm);
    const lines = [
      // ^CI28 = UTF-8, ^PW/^LL = media size, ^LH origin, ^PR slow enough for crisp bars
      "^XA",
      "^CI28",
      `^PW${r.widthDots}`,
      `^LL${r.heightDots}`,
      "^LH0,0",
      "^PR3",
      ...r.images.map((i) => `^FO${i.x},${i.y}${toGraphicField(i.bitmap)}^FS`),
      ...r.texts.map((t) => `^FO${t.x},${t.y}${toGraphicField(t.bitmap)}^FS`),
    ];
    if (r.barcode) {
      const b = r.barcode;
      lines.push(`^FO${b.x},${b.y}^BY${b.moduleDots},3,${b.heightDots}^BCN,${b.heightDots},N,N,N${FH}^FD${fd(ascii(b.code))}^FS`);
    }
    lines.push("^XZ");
    const block = lines.join("\n");
    for (let i = 0; i < copies; i++) out.push(block);
  }
  return out.join("\n") + "\n";
}
