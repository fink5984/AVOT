import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { analyzeDeskew, processBook } from "@/server/services/book-image";
import { DEFAULT_PROCESSING, photoProcessingSchema, type PhotoProcessing } from "@/lib/imaging/settings";
import { decideDeskew, DESKEW_LIMITS } from "@/lib/imaging/deskew";
import { creamFill, leatherFill, openBook, renderScene, roundedRect, type Poly, type Rgb } from "./imaging-fixtures";

const settings = (over: Partial<PhotoProcessing["settings"]> = {}, edits?: PhotoProcessing["edits"]): PhotoProcessing =>
  photoProcessingSchema.parse({ settings: { ...DEFAULT_PROCESSING, rotation: 0, marginPct: 0, ...over }, edits });

const rot = (p: Poly, cx: number, cy: number, deg: number): Poly => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return p.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
};

const W = 2400;
const H = 1600;
type Fill = (x: number, y: number) => Rgb;

async function jpegOf(rgb: Uint8Array, w = W, h = H) {
  return sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

/** several outlines on one table: the first defines the scene, the others are painted on top with their own fill */
async function photo(outlines: { poly: Poly; fill: Fill }[], extra: Partial<Parameters<typeof renderScene>[0]> = {}) {
  const base = renderScene({ width: W, height: H, outline: outlines[0]!.poly, fill: outlines[0]!.fill, ...extra });
  const pixels = base.rgb;
  for (const o of outlines.slice(1)) {
    const layer = renderScene({ width: W, height: H, outline: o.poly, fill: o.fill, noise: 0, vignette: extra.vignette });
    for (let i = 0; i < layer.truth.length; i++) if (layer.truth[i]) pixels.set(layer.rgb.subarray(i * 3, i * 3 + 3), i * 3);
  }
  return jpegOf(pixels);
}

const book = (a: number, cx = 1200, cy = 800, w = 800, h = 1100) => rot(roundedRect(cx - w / 2, cy - h / 2, w, h, 18, 6), cx, cy, a);
const leather = leatherFill(800, 250);

describe("auto deskew — a single item is straightened by rotation only", () => {
  for (const tilt of [1, 2, -2, 3.2, 5, -5, 7]) {
    it(`book tilted by ${tilt}° stands straight afterwards, at its own proportions`, async () => {
      const r = await processBook(await photo([{ poly: book(tilt), fill: leather }]), settings(), "full");
      expect(r.deskew.applied).toBe(true);
      expect(Math.abs(r.deskew.angle + tilt)).toBeLessThan(0.25);
      expect(Math.abs(r.width - 800)).toBeLessThanOrEqual(12);
      expect(Math.abs(r.height - 1100)).toBeLessThanOrEqual(12);
      expect(Math.abs(r.width / r.height - 800 / 1100)).toBeLessThan(0.012);
    });
  }

  it("a straight book is not touched", async () => {
    const r = await processBook(await photo([{ poly: book(0), fill: leather }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
    expect(r.deskew.skip).toBe("already-straight");
    expect(Math.abs(r.width - 800)).toBeLessThanOrEqual(4);
  });

  it("a book shot slightly from the front (wider bottom) keeps its perspective — it is not made rectangular", async () => {
    const trap: Poly = [[1060, 250], [1340, 250], [1380, 1350], [1020, 1350]]; // 280 wide on top, 360 at the bottom
    const r = await processBook(await photo([{ poly: trap, fill: leather }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
    expect(Math.abs(r.width - 360)).toBeLessThanOrEqual(6);
    expect(Math.abs(r.height - 1100)).toBeLessThanOrEqual(6);
    const { data, info } = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels]!;
    expect(px(2, 2)).toBeGreaterThan(240); // top-left corner still cut away: still a trapezoid
    expect(px(info.width >> 1, 40)).toBeLessThan(200);
  });

  it("a tilted trapezoid is rotated by its overall direction only", async () => {
    const trap: Poly = [[1050, 250], [1350, 250], [1390, 1350], [1010, 1350]]; // 300 wide on top, 380 at the bottom
    const r = await processBook(await photo([{ poly: rot(trap, 1200, 800, 3), fill: leather }]), settings(), "full");
    expect(r.deskew.applied).toBe(true);
    expect(Math.abs(r.deskew.angle + 3)).toBeLessThan(0.5);
    expect(Math.abs(r.height - 1100)).toBeLessThanOrEqual(14);
    expect(Math.abs(r.width - 380)).toBeLessThanOrEqual(14); // still wider at the bottom: only rotated
  });

  it("a very strong perspective is never rotated by a wrong angle (rotated correctly or left alone)", async () => {
    const trap: Poly = [[1060, 250], [1340, 250], [1380, 1350], [1020, 1350]];
    const r = await processBook(await photo([{ poly: rot(trap, 1200, 800, 3), fill: leather }]), settings(), "full");
    if (r.deskew.applied) expect(Math.abs(r.deskew.angle + 3)).toBeLessThan(1);
  });

  it("open book with two pages (tilted 3°) is straightened as a whole", async () => {
    const spread = rot(openBook(1200, 800, 1500, 1000, 5), 1200, 800, 3);
    const r = await processBook(await photo([{ poly: spread, fill: creamFill(1200) }]), settings(), "full");
    expect(r.deskew.applied).toBe(true);
    expect(Math.abs(r.deskew.angle + 3)).toBeLessThan(0.7);
  });

  it("works with a shadow, with a transparent background and with a margin", async () => {
    const r = await processBook(
      await photo([{ poly: book(3), fill: leather }], { shadow: { dx: 24, dy: 30, blur: 24, strength: 0.5 } }),
      settings({ background: "transparent", marginPct: 3 }),
      "full",
    );
    expect(r.deskew.applied).toBe(true);
    expect(r.hasAlpha).toBe(true);
    const margin = Math.round(1100 * 0.03);
    expect(Math.abs(r.width - (800 + 2 * margin))).toBeLessThanOrEqual(14);
    expect(Math.abs(r.height - (1100 + 2 * margin))).toBeLessThanOrEqual(14);
    const { data, info } = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[1, 1], [info.width - 2, 1], [1, info.height - 2], [info.width - 2, info.height - 2]] as const) {
      expect(data[(y * info.width + x) * 4 + 3]).toBeLessThan(30);
    }
  });

  it("the preview and the full stage take the same decision", async () => {
    const input = await photo([{ poly: book(4), fill: leather }]);
    const p = settings();
    const preview = await processBook(input, p, "preview", "k1");
    const full = await processBook(input, p, "full", "k1");
    expect(full.deskew).toEqual(preview.deskew);
    expect(Math.abs(full.width / full.height - preview.width / preview.height)).toBeLessThan(0.01);
  });
});

describe("auto deskew — what must NOT be rotated", () => {
  it("several closed books at different angles (a composition) stay exactly as shot", async () => {
    const a = rot(roundedRect(500, 300, 450, 800, 14, 5), 725, 700, 12);
    const b = rot(roundedRect(1100, 350, 450, 800, 14, 5), 1325, 750, -8);
    const c = rot(roundedRect(1650, 300, 400, 780, 14, 5), 1850, 690, 4);
    const input = await photo([{ poly: a, fill: leather }, { poly: b, fill: leatherFill(1100, 350) }, { poly: c, fill: leatherFill(1650, 300) }]);
    const r = await processBook(input, settings({ autoCrop: false, removeBackground: false }), "full");
    expect(r.deskew.applied).toBe(false);
    expect(["multiple-objects", "mixed-directions"]).toContain(r.deskew.skip);
    expect(r.width).toBe(W);
    expect(r.height).toBe(H);
  });

  it("books that touch each other at different angles are one blob with mixed directions — left alone", async () => {
    const a = rot(roundedRect(700, 300, 500, 900, 10, 5), 950, 750, 9);
    const b = rot(roundedRect(1190, 300, 500, 900, 10, 5), 1440, 750, -7);
    const r = await processBook(await photo([{ poly: a, fill: leather }, { poly: b, fill: leatherFill(1190, 300) }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
  });

  it("two open books at different angles stay exactly as shot", async () => {
    const a = rot(openBook(780, 800, 1000, 700, 4), 780, 800, 10);
    const b = rot(openBook(1750, 800, 900, 650, 4), 1750, 800, -6);
    const r = await processBook(await photo([{ poly: a, fill: creamFill(780) }, { poly: b, fill: creamFill(1750) }]), settings({ autoCrop: false }), "full");
    expect(r.deskew.applied).toBe(false);
    expect(["multiple-objects", "mixed-directions"]).toContain(r.deskew.skip);
  });

  it("a deliberately angled item (beyond the automatic range) is reported, not rotated", async () => {
    const r = await processBook(await photo([{ poly: book(25), fill: leather }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
    expect(Math.abs(r.deskew.tilt)).toBeGreaterThan(DESKEW_LIMITS.maxAutoAngle);
    expect(r.deskew.skip).toBe("angle-too-large");
  });

  it("an item cut by the frame is not straightened from its cut edges", async () => {
    const r = await processBook(await photo([{ poly: book(4, 1200, 1000, 800, 1500), fill: leather }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
  });

  it("an unclear outline (backdrop-coloured cover, no contrast) is never rotated", async () => {
    const green: Fill = () => [60, 140, 70];
    const r = await processBook(await photo([{ poly: book(4), fill: green }]), settings(), "full");
    expect(r.deskew.applied).toBe(false);
  });

  it("manual crop / brush strokes are never moved under the user's hands", async () => {
    const input = await photo([{ poly: book(4), fill: leather }]);
    const r = await processBook(input, settings({}, { crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 }, confirmed: true }), "full");
    expect(r.deskew.applied).toBe(false);
    expect(r.deskew.skip).toBe("manual-edits");
    expect(r.width).toBe(Math.round(0.5 * W));
  });

  it("the switch turns it off", async () => {
    const r = await processBook(await photo([{ poly: book(4), fill: leather }]), settings({ autoDeskew: false }), "full");
    expect(r.deskew.applied).toBe(false);
    expect(r.deskew.skip).toBe("disabled");
    expect(r.width).toBeGreaterThan(860); // the crooked bounding box, as before this feature existed
  });
});

describe("auto deskew — repeat runs and quality", () => {
  it("running the same original again gives the same angle; an already straightened picture is not rotated further", async () => {
    const input = await photo([{ poly: book(3.4), fill: leather }]);
    const a = await processBook(input, settings(), "full");
    const b = await processBook(input, settings(), "full");
    expect(b.deskew).toEqual(a.deskew);
    expect(a.deskew.applied).toBe(true);
    // the straightened, cropped picture is analysed again: it must not be rotated a second time
    const tight = await processBook(input, settings({ removeBackground: false }), "full");
    expect(tight.deskew.applied).toBe(true);
    const again = await analyzeDeskew(tight.data, settings());
    expect(again.decision.apply).toBe(false);
  });

  it("the original bytes are not touched and the rotation resamples the picture once (letter sharpness)", async () => {
    // cream page with 2 px "letters": dark strokes every 7 px, broken into dashes
    const fine: Fill = (x, y) => (y % 7 < 2 && x % 9 < 6 ? [30, 30, 40] : [240, 228, 205]);
    const input = await photo([{ poly: book(3), fill: fine }], { noise: 0 });
    const copy = Buffer.from(input);
    const r = await processBook(input, settings({ jpegQuality: 100 }), "full");
    expect(input.equals(copy)).toBe(true);
    expect(r.deskew.applied).toBe(true);

    const lapVar = async (buf: Buffer, crop: { left: number; top: number; width: number; height: number }) => {
      const { data } = await sharp(buf)
        .extract(crop)
        .greyscale()
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let s = 0;
      let q = 0;
      for (const v of data) {
        s += v - 128;
        q += (v - 128) ** 2;
      }
      return q / data.length - (s / data.length) ** 2;
    };
    // reference: ONE bicubic rotation of the same photo by the same angle
    const ref = await sharp(input).rotate(r.deskew.angle, { background: "#2a7a3a" }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    const inner = (w: number, h: number) => ({ left: Math.round(w / 2 - 200), top: Math.round(h / 2 - 200), width: 400, height: 400 });
    const mine = await lapVar(r.data, inner(r.width, r.height));
    const meta = await sharp(ref).metadata();
    const single = await lapVar(ref, inner(meta.width!, meta.height!));
    expect(mine / single).toBeGreaterThan(0.85);
  });

  it("a full-resolution frame (6000×4000) is straightened and cropped within sane time", async () => {
    const w = 6000;
    const h = 4000;
    const poly = rot(roundedRect(2000, 600, 2000, 2800, 40, 6), 3000, 2000, 2.5);
    const scene = renderScene({ width: w, height: h, outline: poly, fill: leatherFill(2000, 600), noise: 0.004, seed: 3 });
    const input = await jpegOf(scene.rgb, w, h);
    const t = Date.now();
    const r = await processBook(input, settings(), "full");
    expect(r.deskew.applied).toBe(true);
    expect(Math.abs(r.width - 2000)).toBeLessThanOrEqual(24);
    expect(Math.abs(r.height - 2800)).toBeLessThanOrEqual(24);
    expect(Date.now() - t).toBeLessThan(110_000);
  }, 300_000);
});

describe("decideDeskew — the shape logic by itself", () => {
  it("measures the signed tilt: clockwise positive, the rotation to apply is the opposite", () => {
    const poly = rot(roundedRect(300, 150, 300, 600, 10, 4), 450, 450, 3);
    const scene = renderScene({ width: 900, height: 900, outline: poly, fill: () => [0, 0, 0], noise: 0 });
    const soft = Uint8Array.from(scene.truth, (v) => v * 255);
    const d = decideDeskew(scene.truth, soft, 900, 900);
    expect(d.tilt).toBeGreaterThan(2);
    expect(d.tilt).toBeLessThan(4);
    expect(d.angle).toBeCloseTo(-d.tilt, 1);
  });
});
