import "server-only";
import sharp from "sharp";
import path from "node:path";
import { barcodeModuleDots, type LabelLayout, type LayoutBarcode, type LayoutImage, type LayoutText } from "@avot/shared";
import { code128Modules } from "@/lib/barcode/code128";
import { renderTextBitmap, type Bitmap } from "./bitmap";

/**
 * Rasterises a LabelLayout at a printer's resolution. This is the only place that turns layout boxes into dots:
 * the ZPL generator prints exactly these bitmaps and bars, and the preview PNG is drawn from the very same result,
 * so what the manager sees in the settings is what comes out of the printer (at the printer's resolution).
 */

export interface PlacedText {
  x: number;
  y: number;
  bitmap: Bitmap;
  item: LayoutText;
}
export interface PlacedImage {
  x: number;
  y: number;
  bitmap: Bitmap;
  item: LayoutImage;
}
export interface PlacedBarcode {
  /** left edge of the symbol (centred in its box), dots */
  x: number;
  y: number;
  moduleDots: number;
  widthDots: number;
  heightDots: number;
  code: string;
  fits: boolean;
  item: LayoutBarcode;
}
export interface RenderedLabel {
  widthDots: number;
  heightDots: number;
  texts: PlacedText[];
  images: PlacedImage[];
  barcode: PlacedBarcode | null;
}

const toDots = (mm: number, dpm: number) => Math.round(mm * dpm);

export const LOGO_FILE = path.join(process.cwd(), "assets", "logo-avot.png");

/** The logo as a 1-bit printer bitmap inside a w×h dot box (artwork centred, white elsewhere). */
async function logoBitmap(w: number, h: number): Promise<Bitmap> {
  const { data, info } = await sharp(LOGO_FILE)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(w, h, { fit: "contain", background: "#ffffff", kernel: "lanczos3" })
    .threshold(140)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bytesPerRow = Math.ceil(info.width / 8);
  const out = Buffer.alloc(bytesPerRow * info.height);
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x]! < 128) out[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
  return { width: info.width, height: info.height, bytesPerRow, data: out };
}

/** the logo as a small PNG for the Windows station (sent once per job, drawn by the driver at its own resolution) */
let gdiLogo: string | null = null;
export async function logoPngBase64(): Promise<string> {
  gdiLogo ??= (await sharp(LOGO_FILE).flatten({ background: "#ffffff" }).greyscale().resize({ width: 480 }).png({ colours: 16, compressionLevel: 9 }).toBuffer()).toString("base64");
  return gdiLogo;
}
const alignOf = (a: LayoutText["align"]) => (a === "center" ? "centre" : a);

export async function renderLabel(layout: LabelLayout, dotsPerMm: number): Promise<RenderedLabel> {
  const texts: PlacedText[] = [];
  const images: PlacedImage[] = [];
  let barcode: PlacedBarcode | null = null;
  for (const item of layout.items) {
    if (item.kind === "image") {
      images.push({ x: toDots(item.x, dotsPerMm), y: toDots(item.y, dotsPerMm), bitmap: await logoBitmap(toDots(item.w, dotsPerMm), toDots(item.h, dotsPerMm)), item });
    } else if (item.kind === "text") {
      const wDots = toDots(item.w, dotsPerMm);
      const hDots = toDots(item.h, dotsPerMm);
      const bitmap = await renderTextBitmap(item.text, {
        width: wDots,
        maxHeight: hDots,
        fontPx: Math.round(item.sizeMm * dotsPerMm),
        minFontPx: Math.max(10, Math.round(item.minSizeMm * dotsPerMm)),
        align: alignOf(item.align),
        bold: item.bold,
        font: item.font,
        maxLines: item.maxLines,
      });
      const free = Math.max(0, hDots - bitmap.height);
      const dy = item.valign === "middle" ? Math.round(free / 2) : item.valign === "bottom" ? free : 0;
      texts.push({ x: toDots(item.x, dotsPerMm), y: toDots(item.y, dotsPerMm) + dy, bitmap, item });
    } else {
      const modules = code128Modules(item.code).reduce((a, b) => a + b, 0);
      const availPx = toDots(item.w, dotsPerMm);
      const { dots, widthPx, fits } = barcodeModuleDots({ modules, availPx, pxPerMm: dotsPerMm, moduleMmMin: item.moduleMmMin, moduleMmMax: item.moduleMmMax, quietModules: item.quietModules });
      barcode = {
        x: toDots(item.x, dotsPerMm) + Math.max(0, Math.round((availPx - widthPx) / 2)),
        y: toDots(item.y, dotsPerMm),
        moduleDots: dots,
        widthDots: widthPx,
        heightDots: toDots(item.h, dotsPerMm),
        code: item.code,
        fits,
        item,
      };
    }
  }
  return { widthDots: toDots(layout.widthMm, dotsPerMm), heightDots: toDots(layout.heightMm, dotsPerMm), texts, images, barcode };
}

/** The label as a PNG (black on white), at the printer's resolution × `scale` for a sharper picture on screen. */
export async function renderLabelPng(rendered: RenderedLabel, scale = 3): Promise<Buffer> {
  const { widthDots: w, heightDots: h } = rendered;
  const grey = Buffer.alloc(w * h, 255);
  for (const t of [...rendered.texts, ...rendered.images]) {
    const b = t.bitmap;
    for (let y = 0; y < b.height; y++) {
      const gy = t.y + y;
      if (gy < 0 || gy >= h) continue;
      for (let x = 0; x < b.width; x++) {
        if (!(b.data[y * b.bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7)))) continue;
        const gx = t.x + x;
        if (gx >= 0 && gx < w) grey[gy * w + gx] = 0;
      }
    }
  }
  const bc = rendered.barcode;
  if (bc) {
    let x = bc.x;
    let isBar = true;
    for (const m of code128Modules(bc.code)) {
      if (isBar) {
        for (let xx = x; xx < x + m * bc.moduleDots && xx < w; xx++) for (let yy = bc.y; yy < Math.min(h, bc.y + bc.heightDots); yy++) grey[yy * w + xx] = 0;
      }
      x += m * bc.moduleDots;
      isBar = !isBar;
    }
  }
  return sharp(grey, { raw: { width: w, height: h, channels: 1 } })
    .resize(w * scale, h * scale, { kernel: "nearest" })
    .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 200, g: 200, b: 200 } })
    .png()
    .toBuffer();
}
