import { runSync, smoothstep, type Pixels } from "./raster";
import { rgbToHsv, scoreColor, type BgModel, type Bbox } from "./segment";
import type { EdgeQuality } from "./settings";

/**
 * Full-resolution stage. The coarse mask comes from the (small) working image
 * and is upscaled to the original size. Around the boundary every pixel is
 * re-decided from its own colour with a colour-difference matte (the "green
 * key" of video work): a pixel that is a mix of book and backdrop has a
 * proportional amount of green excess, so its alpha is the share of the
 * backdrop in it — a real soft edge at the original resolution instead of a
 * staircase upscaled from the working copy. Interior and exterior stay exactly
 * what the robust coarse mask decided.
 */

export interface PlaneInput {
  rgb: Pixels;
  width: number;
  height: number;
  channels: 3 | 4;
}

const BAND_LO = 8;
const BAND_HI = 247;
/** edge-proximity (0..255) above which a pixel is re-decided although the coarse alpha is already solid */
const EDGE_BAND = 205;

/** How each preset shapes the matte and removes the backdrop colour from the edge. */
export const EDGE_PRESETS: Record<EdgeQuality, { lo: number; hi: number; soften: number; spill: number }> = {
  precise: { lo: 0.3, hi: 0.7, soften: 0, spill: 1 },
  natural: { lo: 0.06, hi: 0.94, soften: 1, spill: 0.92 },
  soft: { lo: 0, hi: 1, soften: 2, spill: 0.75 },
};

export interface RefineOptions {
  /** boundary proximity map of the same size as the image (0..255); widens the re-decided band */
  edge?: Uint8Array | null;
  quality?: EdgeQuality;
}

/** Re-decides band pixels of an upscaled coarse alpha from full-resolution colour. */
export function refineAlpha(img: PlaneInput, alphaUp: Uint8Array, forcedUp: Uint8Array | null, model: BgModel, opts: RefineOptions = {}): Uint8Array {
  return runSync(refineAlphaSteps(img, alphaUp, forcedUp, model, opts));
}

const ROWS_PER_STEP = 96;

export function* refineAlphaSteps(
  img: PlaneInput,
  alphaUp: Uint8Array,
  forcedUp: Uint8Array | null,
  model: BgModel,
  opts: RefineOptions = {},
): Generator<void, Uint8Array, void> {
  const { width: w, height: h, channels: ch, rgb } = img;
  const preset = EDGE_PRESETS[opts.quality ?? "natural"];
  const edge = opts.edge ?? null;
  const out = new Uint8Array(alphaUp.length);

  // the backdrop's green excess (g − max(r, b)) and chroma ratio, at the model's reference brightness
  const eB0 = model.rgb[1] - Math.max(model.rgb[0], model.rgb[2]);
  const keyUsable = eB0 >= 12 && model.rgb[1] > 20;
  const ratioB = keyUsable ? eB0 / model.rgb[1] : 0;
  const vMean = Math.max(0.05, model.v);

  for (let y = 0; y < h; y++) {
    if (y % ROWS_PER_STEP === 0) yield;
    const t = y / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alphaUp[i]!;
      if (forcedUp && forcedUp[i]) {
        out[i] = forcedUp[i] === 2 ? 255 : 0;
        continue;
      }
      const nearEdge = edge !== null && edge[i]! >= EDGE_BAND;
      if (a <= BAND_LO && !nearEdge) continue;
      if (a >= BAND_HI && !nearEdge) {
        out[i] = 255;
        continue;
      }
      const o = i * ch;
      const r = rgb[o]!;
      const g = rgb[o + 1]!;
      const b = rgb[o + 2]!;

      if (keyUsable) {
        const vfit = Math.min(1.6, Math.max(0.3, (model.vFit[0] + model.vFit[1] * (x / w) + model.vFit[2] * t) / vMean));
        const e = g - Math.max(r, b);
        let key = e <= 0 ? 1 : Math.max(0, 1 - e / (eB0 * vfit));
        // a shadowed backdrop is darker but keeps its chroma ratio: it is background, not a half-covered edge pixel
        const q = e > 0 ? e / Math.max(g, 1) : 0;
        key = Math.min(key, 1 - smoothstep(0.7 * ratioB, 0.9 * ratioB, q));
        if (a >= BAND_HI && q < 0.9 * ratioB) key = 1; // solid book near the edge: only clear backdrop chroma overrules it
        if (a <= BAND_LO && key > 0.9 && !(q < 0.5 * ratioB)) key = 0; // clear backdrop next to the book stays backdrop
        out[i] = Math.round(255 * smoothstep(preset.lo, Math.max(preset.hi, preset.lo + 0.01), key));
        continue;
      }
      // backdrop that is not clearly green (calibrated other colour): decide from hue/saturation/brightness
      const [hh, ss, vv] = rgbToHsv(r, g, b);
      const fg = scoreColor(hh, ss, vv, x / w, t, model);
      const colorAlpha = smoothstep(0.3, 0.7, fg);
      const coarse = smoothstep(60 / 255, 195 / 255, a / 255);
      const decisive = Math.abs(fg - 0.5) * 2;
      const wgt = decisive * decisive;
      out[i] = Math.round(255 * (wgt * colorAlpha + (1 - wgt) * coarse));
    }
  }
  let cur: Uint8Array = out;
  for (let pass = 0; pass < preset.soften; pass++) cur = yield* softenBand(cur, alphaUp, forcedUp, edge, w, h);
  return cur;
}

/** 3×3 average inside the band only — anti-aliases the decided edge without moving it. */
function* softenBand(alpha: Uint8Array, alphaUp: Uint8Array, forcedUp: Uint8Array | null, edge: Uint8Array | null, w: number, h: number): Generator<void, Uint8Array, void> {
  const out = alpha.slice();
  for (let y = 1; y < h - 1; y++) {
    if (y % (ROWS_PER_STEP * 2) === 0) yield;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = alphaUp[i]!;
      const inBand = (a > BAND_LO && a < BAND_HI) || (edge !== null && edge[i]! >= EDGE_BAND);
      if (!inBand || (forcedUp && forcedUp[i])) continue;
      const s =
        alpha[i - w - 1]! + alpha[i - w]! + alpha[i - w + 1]! + alpha[i - 1]! + alpha[i]! + alpha[i + 1]! + alpha[i + w - 1]! + alpha[i + w]! + alpha[i + w + 1]!;
      out[i] = Math.round(s / 9);
    }
  }
  return out;
}

export interface ComposeInput extends PlaneInput {
  alpha: Uint8Array;
  /** boundary proximity (0..255), same size as the image */
  edge: Uint8Array;
  model: BgModel;
  /** null → transparent output (RGBA) */
  background: [number, number, number] | null;
  /** edge preset: how strongly the backdrop green is removed from the edge */
  quality?: EdgeQuality;
  /** region of the image to output */
  crop: { x: number; y: number; w: number; h: number };
}

/** Removes the green cast near the boundary and composes the final pixels. */
export function composeOutput(input: ComposeInput): { data: Uint8Array; width: number; height: number; channels: 3 | 4 } {
  return runSync(composeOutputSteps(input));
}

export function* composeOutputSteps(input: ComposeInput): Generator<void, { data: Uint8Array; width: number; height: number; channels: 3 | 4 }, void> {
  const { rgb, width: w, channels: ch, alpha, edge, model, background, crop } = input;
  const oc = background ? 3 : 4;
  const out = new Uint8Array(crop.w * crop.h * oc);
  const [br, bg, bb] = model.rgb;
  const spillStrength = EDGE_PRESETS[input.quality ?? "natural"].spill;
  for (let cy = 0; cy < crop.h; cy++) {
    if (cy % ROWS_PER_STEP === 0) yield;
    for (let cx = 0; cx < crop.w; cx++) {
      const i = (crop.y + cy) * w + (crop.x + cx);
      const o = i * ch;
      const d = (cy * crop.w + cx) * oc;
      const a8 = alpha[i]!;
      if (a8 === 0) {
        if (background) {
          out[d] = background[0];
          out[d + 1] = background[1];
          out[d + 2] = background[2];
        }
        continue;
      }
      const a = a8 / 255;
      let r = rgb[o]!;
      let g = rgb[o + 1]!;
      let b = rgb[o + 2]!;
      // un-mix the background colour from partially covered pixels: C = aF + (1-a)B
      if (a < 0.98) {
        r = Math.min(255, Math.max(0, (r - (1 - a) * br) / a));
        g = Math.min(255, Math.max(0, (g - (1 - a) * bg) / a));
        b = Math.min(255, Math.max(0, (b - (1 - a) * bb) / a));
      }
      // green spill: only near the boundary and only for hues of the backdrop
      const prox = a < 0.98 ? 1 : edge[i]! / 255;
      if (prox > 0.02) {
        const [hh, ss] = rgbToHsv(r, g, b);
        const dh = Math.abs(((hh - model.h + 540) % 360) - 180);
        const greenness = ss < 0.1 ? 0 : 1 - smoothstep(model.hueTol, model.hueTol * 1.8, dh);
        const wgt = prox * greenness * spillStrength;
        if (wgt > 0) {
          const limit = (r + b) / 2;
          if (g > limit) g -= (g - limit) * wgt;
        }
      }
      if (background) {
        out[d] = Math.round(r * a + background[0] * (1 - a));
        out[d + 1] = Math.round(g * a + background[1] * (1 - a));
        out[d + 2] = Math.round(b * a + background[2] * (1 - a));
      } else {
        out[d] = Math.round(r);
        out[d + 1] = Math.round(g);
        out[d + 2] = Math.round(b);
        out[d + 3] = a8;
      }
    }
  }
  return { data: out, width: crop.w, height: crop.h, channels: oc };
}

/** Tight bounding box of alpha ≥ 128 inside an optional search window. */
export function alphaBounds(alpha: Uint8Array, w: number, h: number, within?: { x: number; y: number; w: number; h: number }): Bbox | null {
  const x0w = within?.x ?? 0;
  const y0w = within?.y ?? 0;
  const x1w = within ? within.x + within.w : w;
  const y1w = within ? within.y + within.h : h;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = y0w; y < y1w; y++) {
    for (let x = x0w; x < x1w; x++) {
      if (alpha[y * w + x]! >= 128) {
        if (x < x0) x0 = x;
        if (x >= x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y >= y1) y1 = y + 1;
      }
    }
  }
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Bounding box expanded by a margin (% of its longer side), clamped to the image. */
export function withMargin(b: Bbox, marginPct: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const m = Math.round((Math.max(b.x1 - b.x0, b.y1 - b.y0) * marginPct) / 100);
  const x0 = Math.max(0, b.x0 - m);
  const y0 = Math.max(0, b.y0 - m);
  const x1 = Math.min(w, b.x1 + m);
  const y1 = Math.min(h, b.y1 + m);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
