import { z } from "zod";

/**
 * THE label design — one source of truth.
 *
 * `layoutLabel()` turns the content of a label (a book, a shelf, a column) plus the physical stock size and the
 * calibration profile into a list of boxes in millimetres: text boxes and one barcode box. Nothing else decides
 * where anything goes:
 *  - the ZPL for thermal printers is generated from this layout,
 *  - the preview in the printer settings is rasterised from this layout (same text bitmaps, same bars),
 *  - the Windows-driver path (AVOT Capture Desktop) receives this layout and only draws it.
 * Changing the profile in the settings changes every place that prints, with no copy of the design anywhere else.
 * Pure and dependency-free (zod only), so the server, the browser and tests use the very same function.
 */

export const LABEL_TYPES = ["BOOK", "LOCATION", "ZONE"] as const;
export type LabelType = (typeof LABEL_TYPES)[number];

export const LABEL_TYPE_NAMES: Record<LabelType, string> = { BOOK: "תווית ספר", LOCATION: "תווית מדף", ZONE: "תווית עמודה" };

/** The three ready-made typefaces of the labels (all SIL OFL): classic = Frank Ruhl Libre, traditional = David Libre, modern = Heebo. */
export const FONT_STYLES = ["classic", "traditional", "modern"] as const;
export type FontStyle = (typeof FONT_STYLES)[number];
export const FONT_STYLE_NAMES: Record<FontStyle, { name: string; sub: string; family: string }> = {
  classic: { name: "קלאסי", sub: "אופי ספרותי ויוקרתי", family: "Frank Ruhl Libre" },
  traditional: { name: "מסורתי", sub: "אופי עברי מסורתי", family: "David Libre" },
  modern: { name: "מודרני", sub: "נקי ופשוט", family: "Heebo" },
};

export const labelProfileSchema = z.object({
  /** the typeface of every text on the label; one choice for all label types (saving it on one type updates the others) */
  fontStyle: z.enum(FONT_STYLES).default("classic"),
  /** white border on every side */
  marginMm: z.number().min(1).max(6).default(2),
  /** the big text at the top (book title / shelf / column name) — the starting size, it shrinks to fit two lines */
  titleSizeMm: z.number().min(2.5).max(14).default(5),
  titleAlign: z.enum(["center", "right", "left"]).default("center"),
  /** height of the bars */
  barcodeHeightMm: z.number().min(5).max(24).default(10),
  /** the printed number under the bars (book labels) */
  numberSizeMm: z.number().min(2.4).max(8).default(3.8),
  /** space between the three areas */
  gapMm: z.number().min(0.4).max(5).default(1.2),
  /** the AVOT logo next to the book title (book labels only) */
  showLogo: z.boolean().default(true),
});
export type LabelProfile = z.infer<typeof labelProfileSchema>;

export const LABEL_STOCKS: Record<string, { widthMm: number; heightMm: number }> = {
  "50x25": { widthMm: 50, heightMm: 25 },
  "57x32": { widthMm: 57, heightMm: 32 },
  "70x40": { widthMm: 70, heightMm: 40 },
  "100x50": { widthMm: 100, heightMm: 50 },
};

/** Professional starting point per label type; the manager only tunes it once, in the printer settings. */
export const DEFAULT_LABEL_PROFILES: Record<LabelType, LabelProfile> = {
  BOOK: labelProfileSchema.parse({}),
  LOCATION: labelProfileSchema.parse({ titleSizeMm: 10, barcodeHeightMm: 10 }),
  ZONE: labelProfileSchema.parse({ titleSizeMm: 12, barcodeHeightMm: 9 }),
};

/** the stored overrides of one organization: only what differs from the defaults */
export const labelProfilesSchema = z.object({
  BOOK: labelProfileSchema.partial().optional(),
  LOCATION: labelProfileSchema.partial().optional(),
  ZONE: labelProfileSchema.partial().optional(),
});
export type LabelProfilesOverrides = z.infer<typeof labelProfilesSchema>;

export function resolveProfile(type: LabelType, overrides?: LabelProfilesOverrides | null): LabelProfile {
  return labelProfileSchema.parse({ ...DEFAULT_LABEL_PROFILES[type], ...(overrides?.[type] ?? {}) });
}

export type LabelContent =
  | { type: "BOOK"; code: string; inventoryNumber: string; title: string }
  | { type: "LOCATION"; code: string; shelf: string; path: string }
  | { type: "ZONE"; code: string; name: string; warehouse: string }
  | { type: "TEST"; text: string };

export interface LayoutText {
  kind: "text";
  role: "title" | "subtitle" | "number";
  text: string;
  /** box, in mm from the label's top-left corner */
  x: number;
  y: number;
  w: number;
  h: number;
  /** starting font height; the drawing side shrinks it (down to minSizeMm) until the text fits the box */
  sizeMm: number;
  minSizeMm: number;
  bold: boolean;
  align: "center" | "right" | "left";
  valign: "middle" | "top" | "bottom";
  /** at most this many lines: the font shrinks first, then the text is cut with an ellipsis */
  maxLines: number;
  /** the typeface (the drawing side loads the matching bundled file; there is no dependence on installed fonts) */
  font: FontStyle;
}

export interface LayoutBarcode {
  kind: "barcode";
  /** exactly the stored barcode value — never changed by the design */
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** a module (narrowest bar) is whole printer dots between these widths; wider = more reliable */
  moduleMmMin: number;
  moduleMmMax: number;
  /** clear space needed beside the symbol, in modules */
  quietModules: number;
}

/** The AVOT logo. The picture itself is a server asset (it is drawn / sent by id), the layout only says where it goes. */
export interface LayoutImage {
  kind: "image";
  role: "logo";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** width / height of the logo artwork */
export const LOGO_ASPECT = 1.8;

export type LayoutItem = LayoutText | LayoutBarcode | LayoutImage;

export interface LabelLayout {
  widthMm: number;
  heightMm: number;
  /** what the label is, for tests and diagnostics */
  type: LabelContent["type"];
  items: LayoutItem[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const BARCODE_MODULE = { moduleMmMin: 0.25, moduleMmMax: 0.5, quietModules: 10 } as const;

/**
 * Whole dots per module for a Code 128 symbol of `modules` modules in a box `availPx` wide: as wide as allowed, but
 * the symbol plus its quiet zones must fit. Used identically by the ZPL generator, the preview and the Windows drawer.
 */
export function barcodeModuleDots(opts: { modules: number; availPx: number; pxPerMm: number; moduleMmMin: number; moduleMmMax: number; quietModules: number }): { dots: number; widthPx: number; fits: boolean } {
  const lo = Math.max(1, Math.ceil(opts.moduleMmMin * opts.pxPerMm - 1e-9));
  const hi = Math.max(lo, Math.floor(opts.moduleMmMax * opts.pxPerMm + 1e-9));
  const fitting = Math.floor(opts.availPx / (opts.modules + 2 * opts.quietModules));
  if (fitting >= lo) {
    const dots = Math.min(hi, fitting);
    return { dots, widthPx: dots * opts.modules, fits: true };
  }
  // too long for the minimum module even with the quiet zones: use what the box allows and say it is tight
  const dots = Math.max(1, Math.floor(opts.availPx / opts.modules));
  return { dots, widthPx: dots * opts.modules, fits: false };
}

/** Vertical stack: [title zone] [barcode] [number]. The title zone takes whatever the other two leave. */
function stack(opts: {
  w: number;
  h: number;
  profile: LabelProfile;
  title: Pick<LayoutText, "text" | "sizeMm" | "minSizeMm" | "role">;
  subtitle?: Pick<LayoutText, "text" | "sizeMm" | "minSizeMm" | "role">;
  code: string;
  number?: string;
  /** share of the height the title zone may not drop below */
  titleMinShare: number;
  logo?: boolean;
}): LayoutItem[] {
  const { w, h, profile: p } = opts;
  const m = p.marginMm;
  const innerW = w - 2 * m;
  const innerH = h - 2 * m;
  const gap = p.gapMm;
  const numberH = opts.number ? round2(p.numberSizeMm * 1.3) : 0;
  const subtitleH = opts.subtitle ? round2(opts.subtitle.sizeMm * 1.35) : 0;
  const gaps = (opts.number ? 2 : 1) * gap;
  let barH = Math.min(p.barcodeHeightMm, innerH * 0.55);
  let titleH = innerH - barH - numberH - subtitleH - gaps;
  const minTitle = innerH * opts.titleMinShare;
  if (titleH < minTitle) {
    // not enough room: the bars give way first, never below 5 mm (still scans from a phone)
    barH = Math.max(5, barH - (minTitle - titleH));
    titleH = innerH - barH - numberH - subtitleH - gaps;
  }
  if (titleH < 3) titleH = 3;

  const items: LayoutItem[] = [];
  let y = m;
  // Header row: the logo at the physical left, the title in the rest of the width. The logo is as tall as the title zone
  // allows but never more than a third of the label or 10 mm — present, not shouting — and is dropped when it would squeeze the title.
  let titleX = m;
  let titleW = innerW;
  if (opts.logo) {
    const logoH = Math.min(titleH, innerH * 0.33, 10);
    const logoW = logoH * LOGO_ASPECT;
    if (logoH >= 5 && innerW - logoW - gap >= innerW * 0.55) {
      items.push({ kind: "image", role: "logo", x: m, y: round2(y + (titleH - logoH) / 2), w: round2(logoW), h: round2(logoH) });
      titleX = m + logoW + gap;
      titleW = innerW - logoW - gap;
    }
  }
  // with a subtitle the title sits right above it; alone it is centred in its zone
  items.push({ kind: "text", ...opts.title, x: round2(titleX), y: round2(y), w: round2(titleW), h: round2(titleH), bold: true, font: p.fontStyle, align: p.titleAlign, valign: opts.subtitle ? "bottom" : "middle", maxLines: 2 });
  y += titleH;
  if (opts.subtitle) {
    items.push({ kind: "text", ...opts.subtitle, x: m, y: round2(y), w: round2(innerW), h: subtitleH, bold: false, font: p.fontStyle, align: p.titleAlign, valign: "top", maxLines: 1 });
    y += subtitleH;
  }
  y += gap;
  items.push({ kind: "barcode", code: opts.code, x: m, y: round2(y), w: round2(innerW), h: round2(barH), ...BARCODE_MODULE });
  y += barH;
  if (opts.number) {
    y += gap;
    items.push({ kind: "text", role: "number", text: opts.number, x: m, y: round2(y), w: round2(innerW), h: numberH, sizeMm: p.numberSizeMm, minSizeMm: Math.min(p.numberSizeMm, 2.4), bold: false, font: p.fontStyle, align: "center", valign: "top", maxLines: 1 });
  }
  return items;
}

/**
 * The layout of one label.
 *  - book: the title large and centred at the top (up to two lines), the Code 128 in the middle, the inventory number
 *    under it. Nothing else (a field can be added later by adding an item here).
 *  - shelf / column: the human name large, the barcode below — the technical code is NOT printed as text.
 */
export function layoutLabel(content: LabelContent, stock: { widthMm: number; heightMm: number }, profile: LabelProfile): LabelLayout {
  const { widthMm: w, heightMm: h } = stock;
  let items: LayoutItem[];
  switch (content.type) {
    case "BOOK":
      items = stack({
        w,
        h,
        profile,
        title: { role: "title", text: content.title, sizeMm: profile.titleSizeMm, minSizeMm: Math.max(2.6, profile.titleSizeMm * 0.5) },
        code: content.code,
        number: content.inventoryNumber,
        titleMinShare: 0.32,
        logo: profile.showLogo,
      });
      break;
    case "LOCATION":
      items = stack({
        w,
        h,
        profile,
        title: { role: "title", text: content.shelf, sizeMm: profile.titleSizeMm, minSizeMm: Math.max(3, profile.titleSizeMm * 0.5) },
        subtitle: { role: "subtitle", text: content.path, sizeMm: Math.min(3.6, Math.max(2.6, round2(profile.titleSizeMm * 0.4))), minSizeMm: 2.2 },
        code: content.code,
        titleMinShare: 0.26,
      });
      break;
    case "ZONE":
      items = stack({
        w,
        h,
        profile,
        title: { role: "title", text: content.name, sizeMm: profile.titleSizeMm, minSizeMm: Math.max(3.5, profile.titleSizeMm * 0.45) },
        subtitle: { role: "subtitle", text: content.warehouse, sizeMm: Math.min(3.6, Math.max(2.8, round2(profile.titleSizeMm * 0.34))), minSizeMm: 2.2 },
        code: content.code,
        titleMinShare: 0.3,
      });
      break;
    default:
      items = stack({ w, h, profile, title: { role: "title", text: content.text, sizeMm: profile.titleSizeMm, minSizeMm: 2.6 }, code: "AVOT-TEST", titleMinShare: 0.3 });
  }
  return { widthMm: w, heightMm: h, type: content.type, items };
}
