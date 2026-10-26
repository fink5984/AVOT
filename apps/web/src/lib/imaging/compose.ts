import { runSync, smoothstep, type Pixels } from "./raster";
import { rgbToHsv, scoreColor, type BgModel, type Bbox } from "./segment";

/**
 * Full-resolution stage. The coarse mask comes from the (small) working image
 * and is upscaled to the original size; here every pixel in the narrow band
 * around the boundary is re-decided from its own colour, so the edge is
 * placed with full-resolution precision while the interior and exterior stay
 * exactly what the robust coarse mask decided.
 */

export interface PlaneInput {
  rgb: Pixels;
  width: number;
  height: number;
  channels: 3 | 4;
}

const BAND_LO = 8;
const BAND_HI = 247;

/** Re-decides band pixels of an upscaled coarse alpha from full-resolution colour. */
export function refineAlpha(img: PlaneInput, alphaUp: Uint8Array, forcedUp: Uint8Array | null, model: BgModel): Uint8Array {
  return runSync(refineAlphaSteps(img, alphaUp, forcedUp, model));
}

const ROWS_PER_STEP = 96;

export function* refineAlphaSteps(img: PlaneInput, alphaUp: Uint8Array, forcedUp: Uint8Array | null, model: BgModel): Generator<void, Uint8Array, void> {
  const { width: w, height: h, channels: ch, rgb } = img;
  const out = new Uint8Array(alphaUp.length);
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
      if (a <= BAND_LO) continue;
      if (a >= BAND_HI) {
        out[i] = 255;
        continue;
      }
      const o = i * ch;
      const [hh, ss, vv] = rgbToHsv(rgb[o]!, rgb[o + 1]!, rgb[o + 2]!);
      const fg = scoreColor(hh, ss, vv, x / w, t, model);
      const colorAlpha = smoothstep(0.3, 0.7, fg);
      const coarse = smoothstep(60 / 255, 195 / 255, a / 255);
      const decisive = Math.abs(fg - 0.5) * 2;
      const wgt = decisive * decisive;
      out[i] = Math.round(255 * (wgt * colorAlpha + (1 - wgt) * coarse));
    }
  }
  return yield* softenBand(out, alphaUp, forcedUp, w, h);
}

/** 3×3 average inside the band only — anti-aliases the decided edge without moving it. */
function* softenBand(alpha: Uint8Array, alphaUp: Uint8Array, forcedUp: Uint8Array | null, w: number, h: number): Generator<void, Uint8Array, void> {
  const out = alpha.slice();
  for (let y = 1; y < h - 1; y++) {
    if (y % (ROWS_PER_STEP * 2) === 0) yield;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = alphaUp[i]!;
      if (a <= BAND_LO || a >= BAND_HI || (forcedUp && forcedUp[i])) continue;
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
        const wgt = prox * greenness;
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
