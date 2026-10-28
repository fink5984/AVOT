import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { DEFAULT_LABEL_PROFILES, LABEL_STOCKS, barcodeModuleDots, layoutLabel, resolveProfile, type LabelContent, type LayoutBarcode, type LayoutText } from "@avot/shared";
import { code128Modules } from "@/lib/barcode/code128";
import { renderLabel, renderLabelPng } from "@/server/labels/render";
import { renderZpl, layoutFor } from "@/server/labels/zpl";

const book = (title: string, n = "10000041"): LabelContent => ({ type: "BOOK", code: n, inventoryNumber: n, title });
const LONG = "שולחן ערוך — אורח חיים, עם פירוש משנה ברורה ובאר היטב והגהות הגר״א (דפוס וילנא, תרמ״ה) — כרך ראשון";
const texts = (l: ReturnType<typeof layoutLabel>) => l.items.filter((i): i is LayoutText => i.kind === "text");
const bars = (l: ReturnType<typeof layoutLabel>) => l.items.find((i): i is LayoutBarcode => i.kind === "barcode")!;

describe("label layout — three areas, nothing else", () => {
  const stock = LABEL_STOCKS["57x32"]!;
  const layout = layoutLabel(book("מקור חיים"), stock, DEFAULT_LABEL_PROFILES.BOOK);

  it("a book label has exactly the logo, the title, the Code 128 and the inventory number", () => {
    expect(layout.items.map((i) => (i.kind === "text" ? i.role : i.kind === "image" ? "logo" : "barcode"))).toEqual(["logo", "title", "barcode", "number"]);
    const [title, number] = texts(layout);
    expect(title!.text).toBe("מקור חיים");
    expect(number!.text).toBe("10000041"); // the number only, no prefix
    expect(bars(layout).code).toBe("10000041"); // the stored barcode, untouched by the design
  });

  it("the title is centred, bold and larger than before (3.6 mm), the bars lower than before", () => {
    const title = texts(layout)[0]!;
    expect(title.align).toBe("center");
    expect(title.bold).toBe(true);
    expect(title.sizeMm).toBeGreaterThanOrEqual(4.5);
    expect(title.sizeMm).toBeGreaterThan(3.6);
    expect(bars(layout).h).toBeLessThanOrEqual(10);
    // the title zone is taller than one line: room for two
    expect(title.h).toBeGreaterThanOrEqual(title.sizeMm * 2);
  });

  it("is stacked top → bottom without overlap and stays inside the label on every stock", () => {
    for (const [key, s] of Object.entries(LABEL_STOCKS)) {
      const l = layoutLabel(book(LONG), s, DEFAULT_LABEL_PROFILES.BOOK);
      const boxes = l.items.filter((i) => i.kind !== "image").map((i) => ({ y: i.y, h: i.h, x: i.x, w: i.w }));
      for (const logo of l.items.filter((i) => i.kind === "image")) {
        const title = l.items.find((i) => i.kind === "text" && i.role === "title")!;
        expect(logo.x + logo.w, key).toBeLessThanOrEqual(title.x + 0.01); // beside the title, never over it
        expect(logo.h).toBeLessThanOrEqual(10);
        expect(logo.h).toBeLessThanOrEqual(s.heightMm / 3 + 0.01); // present, not shouting
        expect(logo.h).toBeGreaterThanOrEqual(5); // and not too small to recognise
      }
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(s.widthMm + 0.01);
        expect(b.y + b.h).toBeLessThanOrEqual(s.heightMm + 0.01);
      }
      for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y, key).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.h - 0.01);
    }
  });

  it("a shelf label shows the human name and never the technical code as text", () => {
    const l = layoutLabel({ type: "LOCATION", code: "LOC-W1-C4-04", shelf: "מדף 4", path: "מחסן 1 › עמודה 4" }, LABEL_STOCKS["70x40"]!, DEFAULT_LABEL_PROFILES.LOCATION);
    expect(texts(l).map((t) => t.text)).toEqual(["מדף 4", "מחסן 1 › עמודה 4"]);
    expect(texts(l).some((t) => /LOC-|COL-/.test(t.text))).toBe(false);
    expect(bars(l).code).toBe("LOC-W1-C4-04");
    const z = layoutLabel({ type: "ZONE", code: "COL-W1-C4", name: "עמודה 4", warehouse: "מחסן 1" }, LABEL_STOCKS["70x40"]!, DEFAULT_LABEL_PROFILES.ZONE);
    expect(texts(z).some((t) => /LOC-|COL-/.test(t.text))).toBe(false);
  });

  it("the logo can be switched off; shelf and column labels never carry it", () => {
    const off = layoutLabel(book("x"), stock, resolveProfile("BOOK", { BOOK: { showLogo: false } }));
    expect(off.items.some((i) => i.kind === "image")).toBe(false);
    expect(layoutLabel({ type: "LOCATION", code: "LOC-1", shelf: "מדף 1", path: "x" }, LABEL_STOCKS["70x40"]!, DEFAULT_LABEL_PROFILES.LOCATION).items.some((i) => i.kind === "image")).toBe(false);
  });

  it("calibration changes the layout; stored overrides are merged over the defaults", () => {
    const tall = resolveProfile("BOOK", { BOOK: { barcodeHeightMm: 14, titleAlign: "right" } });
    const l = layoutLabel(book("x"), LABEL_STOCKS["70x40"]!, tall);
    expect(bars(l).h).toBeCloseTo(14, 1);
    expect(texts(l)[0]!.align).toBe("right");
    expect(resolveProfile("LOCATION", { BOOK: { barcodeHeightMm: 14 } }).barcodeHeightMm).toBe(DEFAULT_LABEL_PROFILES.LOCATION.barcodeHeightMm);
  });
});

describe("barcode modules stay scannable", () => {
  const mods = (code: string) => code128Modules(code).reduce((a, b) => a + b, 0);
  const base = { moduleMmMin: 0.25, moduleMmMax: 0.5, quietModules: 10 };

  it("an 8-digit inventory number gets 4 dots per module (0.5 mm) on a 57 mm label", () => {
    const r = barcodeModuleDots({ modules: mods("10000041"), availPx: 53 * 8, pxPerMm: 8, ...base });
    expect(r.dots).toBe(4);
    expect(r.fits).toBe(true);
    expect(r.widthPx).toBeLessThan(53 * 8);
  });

  it("a medium code is thinned but never below the minimum module while it fits", () => {
    const code = "EXT-9781234567";
    const r = barcodeModuleDots({ modules: mods(code), availPx: 53 * 8, pxPerMm: 8, ...base });
    expect(r.dots).toBeGreaterThanOrEqual(2);
    expect(r.dots * mods(code)).toBeLessThanOrEqual(53 * 8);
    expect(r.fits).toBe(true);
  });

  it("a code too long for the label is flagged, never silently cut", () => {
    const code = "9781234567897-LONG-EXTERNAL-TAG-0001";
    const r = barcodeModuleDots({ modules: mods(code), availPx: 53 * 8, pxPerMm: 8, ...base });
    expect(r.fits).toBe(false);
    expect(r.widthPx).toBeLessThanOrEqual(53 * 8);
  });

  it("reducing the bar height does not change the module width", async () => {
    const stock = LABEL_STOCKS["57x32"]!;
    const a = await renderLabel(layoutLabel(book("x"), stock, resolveProfile("BOOK", { BOOK: { barcodeHeightMm: 12 } })), 8);
    const b = await renderLabel(layoutLabel(book("x"), stock, resolveProfile("BOOK", { BOOK: { barcodeHeightMm: 6 } })), 8);
    expect(b.barcode!.moduleDots).toBe(a.barcode!.moduleDots);
    expect(b.barcode!.heightDots).toBeGreaterThanOrEqual(5 * 8 - 1); // never below 5 mm
    expect(b.barcode!.fits).toBe(true);
  });
});

describe("one engine for ZPL, preview and the Windows driver", () => {
  const stock = LABEL_STOCKS["57x32"]!;

  it("the logo is drawn as ink inside its box and shows in the preview and in ZPL", async () => {
    const layout = layoutFor(book("מקור חיים"), stock);
    const r = await renderLabel(layout, 8);
    expect(r.images).toHaveLength(1);
    let ink = 0;
    for (const byte of r.images[0]!.bitmap.data) for (let b = 0; b < 8; b++) if (byte & (1 << b)) ink++;
    expect(ink).toBeGreaterThan(400);
    expect(await renderZpl([book("מקור חיים")], { stock })).toContain(`^FO${r.images[0]!.x},${r.images[0]!.y}^GFA,`);
  });

  it("a long Hebrew title is fitted into its box (two lines at most) and drawn", async () => {
    const layout = layoutLabel(book(LONG), stock, DEFAULT_LABEL_PROFILES.BOOK);
    const r = await renderLabel(layout, 8);
    const title = r.texts[0]!;
    expect(title.bitmap.height).toBeLessThanOrEqual(Math.round(layout.items[0]!.h * 8));
    let ink = 0;
    for (const byte of title.bitmap.data) for (let b = 0; b < 8; b++) if (byte & (1 << b)) ink++;
    expect(ink).toBeGreaterThan(400);
  });

  it("ZPL, the preview and the layout sent to the Windows station describe the same boxes", async () => {
    const content = book("מקור חיים");
    const layout = layoutFor(content, stock);
    const r = await renderLabel(layout, 8);
    const zpl = await renderZpl([content], { stock, dotsPerMm: 8 });
    const b = r.barcode!;
    expect(zpl).toContain(`^FO${b.x},${b.y}^BY${b.moduleDots},3,${b.heightDots}^BCN,${b.heightDots},N,N,N`);
    for (const t of r.texts) expect(zpl).toContain(`^FO${t.x},${t.y}^GFA,`);
    const png = await renderLabelPng(r, 3);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(r.widthDots * 3 + 2);
    expect(meta.height).toBe(r.heightDots * 3 + 2);
    // the station gets this exact layout as JSON
    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout);
  });

  it("the preview shows the bars where ZPL prints them (black pixels in the barcode box, white above and below)", async () => {
    const r = await renderLabel(layoutFor(book("x"), stock), 8);
    const { data, info } = await sharp(await renderLabelPng(r, 1)).raw().toBuffer({ resolveWithObject: true });
    const b = r.barcode!;
    const px = (x: number, y: number) => data[((y + 1) * info.width + (x + 1)) * info.channels]!;
    const midY = b.y + Math.floor(b.heightDots / 2);
    let black = 0;
    for (let x = b.x; x < b.x + b.widthDots; x++) if (px(x, midY) === 0) black++;
    expect(black).toBeGreaterThan(b.widthDots * 0.3);
    expect(px(b.x - 2, midY)).toBe(255); // quiet zone
  });

  it("works at 300 dpi too (12 dots/mm)", async () => {
    const r = await renderLabel(layoutFor(book("x"), stock), 12);
    expect(r.widthDots).toBe(684);
    expect(r.barcode!.moduleDots).toBeGreaterThanOrEqual(3);
    expect(r.barcode!.fits).toBe(true);
  });
});
