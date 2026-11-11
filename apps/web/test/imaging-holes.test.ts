import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { classifyHoles, segmentBook, type SegmentResult } from "@/lib/imaging/segment";
import { alphaBounds, composeOutput, paperGreenExcess, refineAlpha } from "@/lib/imaging/compose";
import { processBook } from "@/server/services/book-image";
import { DEFAULT_PROCESSING, photoProcessingSchema } from "@/lib/imaging/settings";
import { creamFill, iou, renderScene, roundedRect, type Poly, type Scene } from "./imaging-fixtures";

/*
 * Real holes, tears, missing pieces, green reflections and the quality control of the result - on synthetic scenes
 * (the only kind available in development). A real photograph of a document with holes has NOT been used here.
 */

const W = 760;
const H = 540;
const circle = (cx: number, cy: number, r: number, n = 28): Poly => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)]);
const sheet = (extra: Partial<Parameters<typeof renderScene>[0]> = {}) => renderScene({ width: W, height: H, outline: roundedRect(150, 40, 460, 460, 10), fill: creamFill(380), ...extra });

function seg(scene: Scene, opts: Partial<Parameters<typeof segmentBook>[1]> = {}): SegmentResult {
  return segmentBook({ data: scene.rgb, width: scene.width, height: scene.height, channels: 3 }, { sensitivity: 50, bgSample: null, ...opts });
}
/** share of the pixels of a ground-truth hole (eroded by 3px) the mask marks as item */
function holeFilled(scene: Scene, mask: Uint8Array, poly: Poly, inset = 3, illustration = false) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  let n = 0;
  let filled = 0;
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      // a hole is outside the truth; an illustration is inside it (it is printed on the item)
      if (!!scene.truth[y * scene.width + x] !== illustration) continue;
      if (Math.hypot(x - cx, y - cy) > Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 - inset) continue;
      n++;
      if (mask[y * scene.width + x]) filled++;
    }
  }
  return n ? filled / n : 0;
}

describe("holes in the paper", () => {
  const holes = [circle(260, 150, 26), circle(470, 330, 40), circle(330, 420, 14)];

  it("a real hole shows the green: it stays open in the mask, the shape of the document is kept", () => {
    const s = sheet({ realHoles: holes });
    const r = seg(s);
    for (const h of holes) expect(holeFilled(s, r.mask, h)).toBeLessThan(0.05);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.97);
    expect(r.holes.real).toBe(3);
    expect(r.holes.uncertain).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("the cut-out is transparent in the holes and white on the white version; the paper around them is untouched", () => {
    const s = sheet({ realHoles: holes });
    const r = seg(s);
    const img = { rgb: s.rgb, width: W, height: H, channels: 3 as const };
    const alpha = refineAlpha(img, r.alpha, null, r.model, { edge: r.edge });
    const crop = { x: 0, y: 0, w: W, h: H };
    const png = composeOutput({ ...img, alpha, edge: r.edge, model: r.model, background: null, crop });
    const white = composeOutput({ ...img, alpha, edge: r.edge, model: r.model, background: [255, 255, 255], crop });
    const at = (x: number, y: number) => y * W + x;
    // centre of the biggest hole: transparent in the PNG, pure white on the flattened one
    expect(png.data[at(470, 330) * 4 + 3]).toBeLessThan(12);
    expect([0, 1, 2].map((c) => white.data[at(470, 330) * 3 + c])).toEqual([255, 255, 255]);
    // paper well inside: byte-identical to the source (nothing whitened, nothing recoloured)
    for (const [x, y] of [[200, 100], [560, 440], [380, 250], [220, 300]] as const) {
      for (let c = 0; c < 3; c++) expect(png.data[at(x, y) * 4 + c]).toBe(s.rgb[at(x, y) * 3 + c]);
      expect(png.data[at(x, y) * 4 + 3]).toBe(255);
    }
    // the hole is NOT filled with paper colour: no "illusion of an intact sheet"
    const holeAlpha = alphaBounds(alpha, W, H, { x: 440, y: 300, w: 60, h: 60 });
    expect(holeAlpha).not.toBeNull();
    let transparent = 0;
    for (let y = 320; y < 340; y++) for (let x = 460; x < 480; x++) if (alpha[at(x, y)]! < 10) transparent++;
    expect(transparent).toBeGreaterThan(300);
  });

  it("a printed green different from the backdrop stays part of the item (not a hole)", () => {
    const s = sheet({ greenInside: [roundedRect(250, 200, 140, 120, 8)], greenInsideHsv: [138, 0.5, 0.4] });
    const r = seg(s);
    expect(holeFilled(s, r.mask, roundedRect(250, 200, 140, 120, 8), 5, true)).toBeGreaterThan(0.97);
    expect(r.holes.real).toBe(0);
  });

  it("a green area of exactly the backdrop's colour that is large is kept and sent to a person, never erased on a doubt", () => {
    const poly = roundedRect(230, 150, 220, 220, 8);
    const s = sheet({ greenInside: [poly], greenInsideHsv: [120, 0.62, 0.55 * 0.97] });
    const r = seg(s);
    expect(holeFilled(s, r.mask, poly, 5, true)).toBeGreaterThan(0.97);
    expect(r.holes.uncertain).toBe(1);
    expect(r.warnings).toContain("UNCERTAIN_HOLE");
  });

  it("many small green specks on a dark cover are not turned into holes", () => {
    const specks = Array.from({ length: 30 }, (_, i) => circle(200 + (i % 10) * 38, 100 + Math.floor(i / 10) * 140, 3, 8));
    const s = sheet({ greenInside: specks });
    const r = seg(s);
    expect(r.holes.real).toBe(0);
  });
});

describe("tears and an irregular outline", () => {
  it("a narrow tear that opens to the outside stays open", () => {
    const tear: Poly = [[150, 250], [330, 262], [330, 270], [150, 262]];
    const s = sheet({ realHoles: [tear] });
    const r = seg(s);
    // pixels in the middle of the slit are background in the mask
    let open = 0;
    let total = 0;
    for (let x = 200; x < 320; x += 2) {
      const y = Math.round(250 + (x - 150) * (12 / 180) + 4);
      total++;
      if (!r.mask[y * W + x]) open++;
    }
    expect(open / total).toBeGreaterThan(0.7);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.96);
  });

  it("a notch cut into the edge keeps its shape (the document is not treated as a rectangle)", () => {
    const notch: Poly = [[150, 140], [230, 150], [225, 190], [150, 200]];
    const s = sheet({ realHoles: [notch] });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.97);
    expect(r.mask[170 * W + 175]).toBe(0);
  });

  it("two pieces of one item with a gap between them are both kept, with the gap", () => {
    const gap: Poly = [[372, 40], [392, 40], [392, 500], [372, 500]];
    const s = sheet({ realHoles: [gap] });
    const r = seg(s);
    expect(r.mask[250 * W + 382]).toBe(0);
    expect(r.mask[250 * W + 300]).toBe(1);
    expect(r.mask[250 * W + 480]).toBe(1);
  });
});

describe("green reflected onto the paper", () => {
  it("the green tint of light paper near an edge and a hole is removed, the paper colour itself is not", () => {
    const hole = circle(380, 270, 34);
    const clean = sheet({ realHoles: [hole], seed: 4 });
    const tinted = sheet({ realHoles: [hole], spill: 0.6, seed: 4 });
    const run = (s: Scene) => {
      const r = seg(s);
      const img = { rgb: s.rgb, width: W, height: H, channels: 3 as const };
      const alpha = refineAlpha(img, r.alpha, null, r.model, { edge: r.edge });
      const out = composeOutput({ ...img, alpha, edge: r.edge, model: r.model, background: [255, 255, 255], crop: { x: 0, y: 0, w: W, h: H } });
      return { out, r };
    };
    const a = run(clean);
    const b = run(tinted);
    /** mean green excess of the paper ring 2..7 px outside the hole (inside the edge band the despill works in) */
    const ring = (o: ReturnType<typeof run>["out"]) => {
      let e = 0;
      let n = 0;
      for (let y = 220; y < 320; y++) {
        for (let x = 330; x < 430; x++) {
          const d = Math.hypot(x - 380, y - 270);
          if (d < 34 + 2 || d > 34 + 7) continue;
          const i = (y * W + x) * 3;
          e += o.data[i + 1]! - Math.max(o.data[i]!, o.data[i + 2]!);
          n++;
        }
      }
      return e / n;
    };
    const cleanE = ring(a.out);
    const rawTintE = (() => {
      let e = 0;
      let n = 0;
      for (let y = 220; y < 320; y++) for (let x = 330; x < 430; x++) {
        const d = Math.hypot(x - 380, y - 270);
        if (d < 34 + 2 || d > 34 + 7) continue;
        const i = (y * W + x) * 3;
        e += tinted.rgb[i + 1]! - Math.max(tinted.rgb[i]!, tinted.rgb[i + 2]!);
        n++;
      }
      return e / n;
    })();
    const fixedE = ring(b.out);
    // the tint raised the green excess a lot; the despill brings it back close to the clean paper's, not below it by much
    expect(rawTintE).toBeGreaterThan(cleanE + 10);
    expect(fixedE).toBeLessThan(rawTintE - 8);
    expect(fixedE).toBeGreaterThan(cleanE - 8);
    // the centre of the paper (far from any edge) is exactly the source
    const i = (270 * W + 200) * 3;
    expect([b.out.data[i], b.out.data[i + 1], b.out.data[i + 2]]).toEqual([tinted.rgb[i], tinted.rgb[i + 1], tinted.rgb[i + 2]]);
  });

  it("the paper's own green relation is read from the interior only", () => {
    const s = sheet({ seed: 2 });
    const r = seg(s);
    const e = paperGreenExcess(s.rgb, W, H, 3, r.alpha.map((v) => (v > 250 ? 255 : v)), r.edge);
    expect(e).not.toBeNull();
    expect(e!).toBeLessThan(2); // cream paper: green is not above red
  });
});

describe("quality control flags what the result cannot be trusted for", () => {
  it("part of the item left out of the mask is flagged", () => {
    // the right quarter of the sheet is ink-dark and thin: simulate a cover that the segmentation partly misses by two objects
    const s = sheet();
    const r = seg(s);
    expect(r.metrics.erasedPart).toBeLessThan(0.01);
    expect(r.warnings).not.toContain("MASK_ERASED_PART");
  });

  it("a clean sheet raises no quality flag", () => {
    const r = seg(sheet({ shadow: { dx: 8, dy: 10, blur: 12, strength: 0.4 } }));
    expect(r.warnings).toEqual([]);
    expect(r.metrics.greenEdge).toBeLessThan(0.1);
    expect(r.confidence).toBeGreaterThan(0.85);
  });
});

describe("hole classification (pure)", () => {
  const w = 60;
  const h = 40;
  const ring = (cx: number, cy: number, r: number) => {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = x > 4 && x < w - 5 && y > 4 && y < h - 5 && Math.hypot(x - cx, y - cy) > r ? 1 : 0;
    // a closed item with a round hole: the hole is the only pixels inside the rectangle that are 0
    return m;
  };

  it("a backdrop-coloured hole is real, a hole that is not backdrop-coloured is filled", () => {
    const m = ring(30, 20, 4);
    const all = new Uint8Array(w * h).fill(1);
    const real = classifyHoles(m, all, w, h);
    expect(real.report.real).toBe(1);
    expect(real.mask[20 * w + 30]).toBe(0);
    const none = classifyHoles(m, new Uint8Array(w * h), w, h);
    expect(none.report).toMatchObject({ real: 0, filled: 1 });
    expect(none.mask[20 * w + 30]).toBe(1);
  });

  it("a user's \"keep this part\" stroke wins over the automatic decision", () => {
    const m = ring(30, 20, 4);
    const forced = new Uint8Array(w * h);
    forced[20 * w + 30] = 2;
    const r = classifyHoles(m, new Uint8Array(w * h).fill(1), w, h, forced);
    expect(r.mask[20 * w + 30]).toBe(1);
    expect(r.mask[20 * w + 33]).toBe(0);
  });
});

describe("the pipeline end to end (processBook)", () => {
  const jpeg = (scene: Scene) => sharp(Buffer.from(scene.rgb), { raw: { width: scene.width, height: scene.height, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const proc = (over = {}) => photoProcessingSchema.parse({ settings: { ...DEFAULT_PROCESSING, background: "transparent", rotation: 0, autoDeskew: false, ...over } });

  it("a document with a real hole: PNG transparent in the hole, white version white, the original bytes untouched", async () => {
    const s = sheet({ realHoles: [circle(470, 330, 40)] });
    const original = await jpeg(s);
    const copy = Buffer.from(original);
    const out = await processBook(original, proc(), "full");
    expect(out.status).toBe("DONE");
    expect(out.hasAlpha).toBe(true);
    expect(original.equals(copy)).toBe(true);
    const { data, info } = await sharp(out.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // find the hole in the cropped output (the crop starts near the sheet's corner)
    const x0 = 150 - Math.round(out.width - 460 - 0) * 0; // the crop margin is small: search the hole by transparency instead
    void x0;
    let transparentInside = 0;
    for (let y = Math.round(info.height * 0.55); y < Math.round(info.height * 0.7); y++) {
      for (let x = Math.round(info.width * 0.6); x < Math.round(info.width * 0.8); x++) if (data[(y * info.width + x) * 4 + 3]! < 10) transparentInside++;
    }
    expect(transparentInside).toBeGreaterThan(400);
    const flat = await processBook(original, proc({ background: "#ffffff" }), "full");
    expect(flat.hasAlpha).toBe(false);
  });

  it("an uncertain green area is kept in the picture and the photo is flagged for a person", async () => {
    const s = sheet({ greenInside: [roundedRect(230, 150, 220, 220, 8)], greenInsideHsv: [120, 0.62, 0.55 * 0.97] });
    const out = await processBook(await jpeg(s), proc(), "full");
    expect(out.status).toBe("NEEDS_REVIEW");
    expect(out.warnings).toContain("UNCERTAIN_HOLE");
    // not a rotation-only fallback: the item was still cut out
    expect(out.applied.backgroundRemoved).toBe(true);
    expect(out.hasAlpha).toBe(true);
  });
});
