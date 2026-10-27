import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { code128Modules } from "@/lib/barcode/code128";
import { renderTextBitmap, type Bitmap } from "@/server/labels/bitmap";
import { barcodeModuleWidth, labelStock, renderZpl } from "@/server/labels/zpl";

/** unpacks a printer bitmap (1 = black) into a grey image buffer for inspection */
function toGrey(b: Bitmap) {
  const px = Buffer.alloc(b.width * b.height, 255);
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) if (b.data[y * b.bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7))) px[y * b.width + x] = 0;
  return px;
}
const inkBounds = (b: Bitmap) => {
  let minX = b.width, maxX = -1, ink = 0;
  for (let y = 0; y < b.height; y++)
    for (let x = 0; x < b.width; x++)
      if (b.data[y * b.bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7))) {
        ink++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
  return { ink, minX, maxX };
};

describe("label text bitmaps (Hebrew, RTL)", () => {
  it("draws Hebrew right-aligned inside the label width and never taller than allowed", async () => {
    const b = await renderTextBitmap("מגילת אסתר — מהדורת וילנא (Vilna 1890)", { width: 440, maxHeight: 90, fontPx: 29, bold: true });
    expect(b.width).toBe(440);
    expect(b.height).toBeLessThanOrEqual(90);
    const { ink, maxX } = inkBounds(b);
    expect(ink).toBeGreaterThan(300);
    // RTL text hugs the right edge of the box
    expect(maxX).toBeGreaterThan(420);
    if (process.env.LABEL_PNG_DIR) {
      mkdirSync(process.env.LABEL_PNG_DIR, { recursive: true });
      await sharp(toGrey(b), { raw: { width: b.width, height: b.height, channels: 1 } }).png().toFile(path.join(process.env.LABEL_PNG_DIR, "title.png"));
    }
  });

  it("shrinks and finally truncates a very long title instead of overflowing", async () => {
    const long = "הספר ".repeat(60) + "סוף";
    const b = await renderTextBitmap(long, { width: 440, maxHeight: 80, fontPx: 29 });
    expect(b.height).toBeLessThanOrEqual(80);
    expect(inkBounds(b).ink).toBeGreaterThan(100);
  });

  it("renders Latin text left-aligned", async () => {
    const b = await renderTextBitmap("Biblia Hebraica", { width: 440, maxHeight: 60, fontPx: 29 });
    expect(inkBounds(b).minX).toBeLessThan(10);
  });
});

describe("book / shelf / column label ZPL", () => {
  const stock = labelStock("57x32");

  it("book label: scannable native Code 128 of the stored barcode, readable number, Hebrew as graphic", async () => {
    const zpl = await renderZpl([{ type: "BOOK", code: "ITM-000184", inventoryNumber: "ITM-000184", title: "תלמוד בבלי — מסכת ברכות" }], { stock });
    expect(zpl).toMatch(/^\^XA/);
    expect(zpl).toContain("^PW456");
    expect(zpl).toContain("^LL256");
    expect(zpl).toMatch(/\^BY\d,3,\d+\^BCN,\d+,N,N,N/);
    expect(zpl.match(/\^FH\\\^FDITM-000184\^FS/g)).toHaveLength(2); // barcode + readable number
    const gf = zpl.match(/\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/);
    expect(gf).toBeTruthy();
    const [, total, total2, perRow, hex] = gf!;
    expect(total).toBe(total2);
    expect(hex!.length).toBe(Number(total) * 2);
    expect(Number(perRow)).toBe(Math.ceil((456 - 2 * 16) / 8));
    expect(zpl.trimEnd().endsWith("^XZ")).toBe(true);
  });

  it("prints one format per copy and escapes ZPL control characters in data", async () => {
    const zpl = await renderZpl([{ type: "BOOK", code: "AB^CD~E", inventoryNumber: "AB^CD~E", title: "x" }], { stock, copies: 3 });
    expect(zpl.match(/\^XA/g)).toHaveLength(3);
    expect(zpl).toContain("AB\\5eCD\\7eE");
    expect(zpl).not.toContain("^FDAB^CD");
  });

  it("long external barcodes get a thinner module so the symbol still fits", () => {
    const code = "9781234567897-LONG-EXTERNAL-TAG-0001";
    const avail = 456 - 32;
    const { by, widthDots } = barcodeModuleWidth(code, avail, 3);
    expect(widthDots).toBeLessThanOrEqual(avail);
    expect(by).toBeLessThanOrEqual(3);
    expect(code128Modules(code).length).toBeGreaterThan(50);
  });

  it("shelf and column labels carry their own scannable codes", async () => {
    const zpl = await renderZpl(
      [
        { type: "LOCATION", code: "LOC-C1-03-01", shelf: "מדף 3", path: "מחסן ראשי › עמודה 1" },
        { type: "ZONE", code: "COL-C1", name: "עמודה 1", warehouse: "מחסן ראשי" },
      ],
      { stock: labelStock("70x40"), dotsPerMm: 8 },
    );
    expect(zpl).toContain("^FDLOC-C1-03-01");
    expect(zpl).toContain("^FDCOL-C1");
    expect(zpl.match(/\^XA/g)).toHaveLength(2);
    expect(zpl).toContain("^PW560");
  });
});
