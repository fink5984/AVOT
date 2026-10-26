import { describe, expect, it } from "vitest";
import { segmentBook, sampleBackground } from "@/lib/imaging/segment";
import { residualRotation, exifRotation } from "@/lib/imaging/settings";
import { rotatePixels } from "@/lib/imaging/raster";
import { creamFill, iou, leatherFill, openBook, renderScene, roundedRect, wornBook, type Scene } from "./imaging-fixtures";

const W = 640;
const H = 440;

function seg(scene: Scene, opts: Partial<Parameters<typeof segmentBook>[1]> = {}) {
  return segmentBook({ data: scene.rgb, width: scene.width, height: scene.height, channels: 3 }, { sensitivity: 50, bgSample: null, ...opts });
}

/** share of ground-truth interior pixels (eroded by 6px) that the mask lost */
function holes(scene: Scene, mask: Uint8Array) {
  let inner = 0;
  let lost = 0;
  const g = 6;
  for (let y = g; y < scene.height - g; y++) {
    for (let x = g; x < scene.width - g; x++) {
      let all = true;
      for (let dy = -g; dy <= g && all; dy += g) for (let dx = -g; dx <= g; dx += g) if (!scene.truth[(y + dy) * scene.width + x + dx]) { all = false; break; }
      if (!all) continue;
      inner++;
      if (!mask[y * scene.width + x]) lost++;
    }
  }
  return inner ? lost / inner : 0;
}

const closedBook = (extra: Partial<Parameters<typeof renderScene>[0]> = {}) =>
  renderScene({ width: W, height: H, outline: roundedRect(170, 30, 300, 380, 14), fill: leatherFill(170, 30), ...extra });

describe("segmentation of a book on the green table", () => {
  it("closed book with rounded corners", () => {
    const s = closedBook();
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.985);
    expect(holes(s, r.mask)).toBeLessThan(0.002);
    expect(r.confidence).toBeGreaterThan(0.85);
    expect(r.warnings).toEqual([]);
  });

  it("open book with wavy pages and bright cream paper", () => {
    const s = renderScene({ width: W, height: H, outline: openBook(320, 220, 520, 330, 9), fill: creamFill(320) });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.98);
    expect(holes(s, r.mask)).toBeLessThan(0.002);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("worn, irregular edges and chipped corners", () => {
    const s = renderScene({ width: W, height: H, outline: wornBook(160, 30, 320, 380, 7), fill: leatherFill(160, 30), seed: 3 });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.975);
    expect(r.confidence).toBeGreaterThan(0.75);
  });

  it("soft shadow around the book does not become part of the book", () => {
    const s = closedBook({ shadow: { dx: 12, dy: 14, blur: 18, strength: 0.55 } });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.975);
    expect(r.confidence).toBeGreaterThan(0.75);
  });

  it("green-tinted cover (olive) next to the green backdrop", () => {
    const s = closedBook({ fill: () => [96, 116, 52] });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.97);
    expect(holes(s, r.mask)).toBeLessThan(0.01);
  });

  it("dark green cover keeps its silhouette", () => {
    const s = closedBook({ fill: () => [18, 52, 24] });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.96);
  });

  it("a green illustration fully enclosed by the cover is not cut out", () => {
    const s = closedBook({ greenInside: [roundedRect(240, 120, 160, 140, 10)] });
    const r = seg(s);
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.98);
    expect(holes(s, r.mask)).toBeLessThan(0.002);
  });

  it("uneven lighting across the backdrop", () => {
    const s = closedBook({ vignette: 0.6 });
    expect(iou(seg(s).mask, s.truth)).toBeGreaterThan(0.975);
  });

  it("a calibrated background colour works as well as automatic detection", () => {
    const s = closedBook({ bg: [105, 0.55, 0.6] });
    const sample = sampleBackground({ data: s.rgb, width: W, height: H, channels: 3 }, 20, 20, 5);
    const r = seg(s, { bgSample: sample });
    expect(iou(r.mask, s.truth)).toBeGreaterThan(0.98);
    expect(r.model.calibrated).toBe(true);
  });

  it("sensitivity trades detail against background removal", () => {
    const s = closedBook({ shadow: { dx: 10, dy: 12, blur: 14, strength: 0.6 } });
    const low = seg(s, { sensitivity: 10 });
    const high = seg(s, { sensitivity: 90 });
    const area = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
    expect(area(high.mask)).toBeLessThanOrEqual(area(low.mask));
  });
});

describe("confidence and non-destructive behaviour", () => {
  it("no green backdrop → low confidence, flagged", () => {
    const s = closedBook({ bg: [30, 0.05, 0.45] });
    const r = seg(s);
    expect(r.confidence).toBeLessThan(0.6);
    expect(r.warnings).toContain("BG_NOT_FOUND");
  });

  it("empty green table → nothing found", () => {
    const s = renderScene({ width: W, height: H, outline: roundedRect(-50, -50, 10, 10, 2), fill: () => [0, 0, 0] });
    const r = seg(s);
    expect(r.bbox).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("book filling the whole frame is flagged", () => {
    const s = renderScene({ width: W, height: H, outline: roundedRect(0, 0, W, H, 1), fill: leatherFill(0, 0) });
    const r = seg(s);
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("manual strokes erase leftover background and restore removed book parts", () => {
    const s = closedBook();
    const base = seg(s);
    const erased = seg(s, { strokes: [{ mode: "erase", r: 0.04, pts: [[0.5, 0.5]] }] });
    expect(erased.mask[220 * W + 320]).toBe(0);
    expect(base.mask[220 * W + 320]).toBe(1);
    const kept = seg(s, { strokes: [{ mode: "keep", r: 0.03, pts: [[0.1, 0.1]] }] });
    expect(kept.mask[Math.round(0.1 * (H - 1)) * W + Math.round(0.1 * (W - 1))]).toBe(1);
  });
});

describe("orientation", () => {
  it("rotates pixels by multiples of 90°", () => {
    const px = new Uint8Array([1, 2, 3, 4, 5, 6]); // 3×2, one channel
    expect(Array.from(rotatePixels(px, 3, 2, 1, 180).data)).toEqual([6, 5, 4, 3, 2, 1]);
    const r90 = rotatePixels(px, 3, 2, 1, 90);
    expect([r90.width, r90.height, ...r90.data]).toEqual([2, 3, 4, 1, 5, 2, 6, 3]);
    const r270 = rotatePixels(px, 3, 2, 1, 270);
    expect([r270.width, r270.height, ...r270.data]).toEqual([2, 3, 3, 6, 2, 5, 1, 4]);
  });

  it("an EXIF-rotated file is never rotated twice", () => {
    expect(exifRotation(3)).toBe(180);
    expect(residualRotation(1, 180)).toBe(180);
    expect(residualRotation(3, 180)).toBe(0); // camera already wrote Orientation=3
    expect(residualRotation(6, 180)).toBe(90);
    expect(residualRotation(undefined, 0)).toBe(0);
    expect(residualRotation(3, 0)).toBe(180);
  });
});
