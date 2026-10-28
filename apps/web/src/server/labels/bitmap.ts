import "server-only";
import path from "node:path";
import sharp from "sharp";

/**
 * Text → 1-bit bitmap for thermal printers. Hebrew is drawn here (Pango + the bundled Heebo font, OFL)
 * instead of relying on a font installed in the printer, so RTL order and long names print identically
 * on every ZPL model. The result is sent to the printer as a ^GF graphic.
 */
export const LABEL_FONT_FILE = path.join(process.cwd(), "assets", "fonts", "Heebo.ttf");

export interface Bitmap {
  width: number;
  height: number;
  bytesPerRow: number;
  /** packed rows, MSB first, 1 = black */
  data: Buffer;
}

export interface TextBitmapOptions {
  /** available width in dots */
  width: number;
  /** tallest allowed result in dots; the font shrinks (then the text is cut with an ellipsis) until it fits */
  maxHeight: number;
  /** starting font size in dots */
  fontPx: number;
  minFontPx?: number;
  align?: "right" | "left" | "centre";
  bold?: boolean;
  /** at most this many lines: the font shrinks, then the text is cut with an ellipsis */
  maxLines?: number;
}

const hasHebrew = (s: string) => /[֐-׿]/.test(s);

async function renderOnce(text: string, o: TextBitmapOptions, px: number) {
  const rtl = hasHebrew(text);
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // `rtl` is accepted by sharp's text renderer but missing from its type declarations
  const text_ = {
    text: `<span weight="${o.bold ? 700 : 500}">${escaped}</span>`,
    font: "Heebo",
    fontfile: LABEL_FONT_FILE,
    width: o.width,
    // Pango's base size is 12pt: dpi = 6 × px gives glyphs px high
    dpi: Math.round(px * 6),
    rgba: true,
    align: o.align ?? (rtl ? "right" : "left"),
    rtl,
      wrap: "word-char",
  };
  const img = sharp({ text: text_ as unknown as sharp.CreateText });
  return img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

/** Packs the alpha channel into printer rows (ink where alpha ≥ 50%), placed in a canvas of canvasWidth dots. */
function pack(data: Buffer, width: number, height: number, channels: number, canvasWidth: number, align: "right" | "left" | "centre"): Bitmap {
  const bytesPerRow = Math.ceil(canvasWidth / 8);
  const out = Buffer.alloc(bytesPerRow * height);
  const offset = align === "right" ? canvasWidth - width : align === "centre" ? Math.round((canvasWidth - width) / 2) : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.min(width, canvasWidth); x++) {
      const a = data[(y * width + x) * channels + (channels - 1)]!;
      if (a >= 128) {
        const cx = x + Math.max(0, offset);
        if (cx < canvasWidth) out[y * bytesPerRow + (cx >> 3)]! |= 0x80 >> (cx & 7);
      }
    }
  }
  return { width: canvasWidth, height, bytesPerRow, data: out };
}

export async function renderTextBitmap(text: string, o: TextBitmapOptions): Promise<Bitmap> {
  let shown = text.replace(/\s+/g, " ").trim() || " ";
  let px = o.fontPx;
  const min = o.minFontPx ?? Math.max(14, Math.round(o.fontPx * 0.6));
  const align = o.align ?? (hasHebrew(shown) ? "right" : "left");
  // one line of THIS text at this size (same glyph mix, no wrapping): how many lines the wrapped render really has
  const oneLine = async (text: string, size: number) => (await renderOnce(text, { ...o, width: 20_000 }, size)).info.height;
  for (let guard = 0; guard < 200; guard++) {
    const { data, info } = await renderOnce(shown, o, px);
    const lines = o.maxLines ? Math.max(1, Math.round(info.height / (await oneLine(shown, px)))) : 1;
    if ((info.height <= o.maxHeight && lines <= (o.maxLines ?? 99)) || (px <= min && shown.length <= 2)) {
      return pack(data, info.width, Math.min(info.height, o.maxHeight), info.channels, o.width, align);
    }
    if (px > min) px = Math.max(min, Math.floor(px * 0.88));
    else shown = `${shown.replace(/…$/, "").slice(0, Math.max(1, Math.floor(shown.length * 0.88) - 1)).trimEnd()}…`;
  }
  throw new Error("label text could not be fitted");
}

/** ^GFA,total,total,bytesPerRow,<hex> */
export function toGraphicField(b: Bitmap): string {
  const total = b.data.length;
  return `^GFA,${total},${total},${b.bytesPerRow},${b.data.toString("hex").toUpperCase()}`;
}
