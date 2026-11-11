import type { BgSample, ManualEdits } from "./settings";
import { boxBlur, countSet, dilate, erode, fillHoles, labelComponents, runSync, smoothstep, type RgbImage } from "./raster";

/**
 * Book / background segmentation for a book photographed on a uniform green
 * surface.
 *
 * The background is modelled from the frame border (or a calibrated sample) in
 * HSV: hue and saturation identify the green, brightness is only constrained
 * loosely so shadows (darker, same hue) still count as background. A pixel is
 * foreground when its hue, saturation or brightness leaves the model, or when
 * it is clearly textured. The mask is then built with hysteresis and cleaned
 * with careful morphology; only the component that matters is kept, enclosed
 * holes (green illustrations inside the book) are filled, and the result gets
 * a confidence score. Nothing here is a fixed colour threshold: tolerances
 * come from the measured spread of the background and the sensitivity setting.
 */

export type WarningCode =
  | "BG_NOT_FOUND"
  | "TOO_SMALL"
  | "NO_BACKGROUND"
  | "TOUCHES_FRAME"
  | "AMBIGUOUS_EDGE"
  | "SPARSE_SHAPE"
  | "MULTIPLE_OBJECTS"
  /** a green area inside the item that may be a real hole or printed colour: kept as it is (not erased) and sent to a person */
  | "UNCERTAIN_HOLE"
  /** a stripe of backdrop green is left along the edge of the item */
  | "GREEN_EDGE"
  /** something that looks like part of the item (clear foreground colour) is outside the mask */
  | "MASK_ERASED_PART";

/** Warnings that are quality-control findings about the RESULT (the processed picture is kept, but a person must look at it). */
export const QC_WARNINGS: readonly WarningCode[] = ["UNCERTAIN_HOLE", "GREEN_EDGE", "MASK_ERASED_PART"];

/**
 * What was decided about the enclosed areas inside the item:
 *  - real:       backdrop shows through a hole in the paper: left transparent (white on the white version)
 *  - uncertain:  looks like backdrop but cannot be told from printed colour (large, or not clearly backdrop): kept, flagged
 *  - filled:     everything else (illustrations, ink, dark areas, specks): kept as part of the item
 */
export interface HoleReport {
  real: number;
  uncertain: number;
  filled: number;
  /** share of the item's area (before the real holes are removed) that is real hole */
  realShare: number;
}

export interface BgModel {
  /** background colour (hue 0..360, saturation / value 0..1) */
  h: number;
  s: number;
  v: number;
  /** mean background colour, 0..255 */
  rgb: [number, number, number];
  hueTol: number;
  satLow: number;
  satTolLow: number;
  satTolHigh: number;
  shadowMin: number;
  brightMax: number;
  /** planar fit of the background brightness: v ≈ a + b·u + c·t (u, t in 0..1) */
  vFit: [number, number, number];
  /** share of border pixels that look like the background */
  coverage: number;
  calibrated: boolean;
}

export interface Bbox {
  x0: number;
  y0: number;
  /** exclusive */
  x1: number;
  y1: number;
}

export interface SegmentOptions {
  sensitivity: number;
  bgSample: BgSample | null;
  strokes?: ManualEdits["strokes"];
}

export interface SegmentResult {
  width: number;
  height: number;
  /** soft alpha 0..255 */
  alpha: Uint8Array;
  /** binary foreground 0/1 */
  mask: Uint8Array;
  /** 255 at the book boundary, falling to 0 away from it (used for spill suppression) */
  edge: Uint8Array;
  /** 0 = automatic, 1 = user erased, 2 = user kept */
  forced: Uint8Array;
  bbox: Bbox | null;
  confidence: number;
  warnings: WarningCode[];
  model: BgModel;
  metrics: { areaFraction: number; borderCoverage: number; touchesFrame: number; bboxFill: number; ambiguity: number; greenEdge: number; erasedPart: number };
  holes: HoleReport;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function circDist(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Tolerance multiplier from the 0..100 sensitivity slider (50 → 1). */
function sensitivityFactor(sensitivity: number) {
  return Math.pow(2, (clamp(sensitivity, 0, 100) - 50) / 50);
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [h, max === 0 ? 0 : d / max, max];
}

interface Planes {
  H: Float32Array;
  S: Float32Array;
  V: Float32Array;
  L: Float32Array;
}

function toPlanes(img: RgbImage): Planes {
  const n = img.width * img.height;
  const H = new Float32Array(n);
  const S = new Float32Array(n);
  const V = new Float32Array(n);
  const L = new Float32Array(n);
  const d = img.data;
  const ch = img.channels;
  for (let i = 0, o = 0; i < n; i++, o += ch) {
    const r = d[o]! / 255;
    const g = d[o + 1]! / 255;
    const b = d[o + 2]! / 255;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const dl = max - min;
    let h = 0;
    if (dl > 0) {
      if (max === r) h = 60 * ((g - b) / dl);
      else if (max === g) h = 60 * ((b - r) / dl + 2);
      else h = 60 * ((r - g) / dl + 4);
      if (h < 0) h += 360;
    }
    H[i] = h;
    S[i] = max === 0 ? 0 : dl / max;
    V[i] = max;
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { H, S, V, L };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Solves the 3×3 normal equations of v ≈ a + b·u + c·t; null when degenerate. */
function fitPlane(us: number[], ts: number[], vs: number[]): [number, number, number] | null {
  let n = 0;
  let su = 0, st = 0, sv = 0, suu = 0, stt = 0, sut = 0, suv = 0, stv = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i]!, t = ts[i]!, v = vs[i]!;
    n++;
    su += u; st += t; sv += v;
    suu += u * u; stt += t * t; sut += u * t;
    suv += u * v; stv += t * v;
  }
  if (n < 12) return null;
  // Cramer's rule on [[n,su,st],[su,suu,sut],[st,sut,stt]]·[a,b,c] = [sv,suv,stv]
  const det = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const A = [
    [n, su, st],
    [su, suu, sut],
    [st, sut, stt],
  ];
  const D = det(A);
  if (Math.abs(D) < 1e-9) return null;
  const col = (k: number) => A.map((row, i) => row.map((x, j) => (j === k ? [sv, suv, stv][i]! : x)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

function estimateBackground(img: RgbImage, p: Planes, opts: SegmentOptions): BgModel {
  const { width: w, height: h } = img;
  const ring = Math.max(2, Math.round(0.03 * Math.min(w, h)));
  const idx: number[] = [];
  for (let y = 0; y < h; y += 2) {
    const edgeRow = y < ring || y >= h - ring;
    for (let x = 0; x < w; x += 2) {
      if (edgeRow || x < ring || x >= w - ring) idx.push(y * w + x);
    }
  }

  // centre colour: the calibrated sample, else the dominant saturated hue of the border
  let h0: number;
  const calibrated = !!opts.bgSample;
  if (opts.bgSample) {
    h0 = opts.bgSample.h;
  } else {
    const bins = new Float32Array(36);
    for (const i of idx) {
      if (p.S[i]! >= 0.2 && p.V[i]! >= 0.1) bins[Math.min(35, Math.floor(p.H[i]! / 10))]! += p.S[i]! * p.V[i]!;
    }
    let best = 0;
    let bestScore = -1;
    for (let b = 0; b < 36; b++) {
      const sc = bins[b]! + 0.5 * (bins[(b + 35) % 36]! + bins[(b + 1) % 36]!);
      if (sc > bestScore) {
        bestScore = sc;
        best = b;
      }
    }
    h0 = best * 10 + 5;
    if (bestScore <= 0) h0 = 120;
  }

  const sel: number[] = [];
  for (const i of idx) {
    if (circDist(p.H[i]!, h0) <= 30 && p.S[i]! >= 0.15 && p.V[i]! >= 0.08) sel.push(i);
  }
  const coverage = idx.length ? sel.length / idx.length : 0;

  const hs: number[] = [];
  const ss: number[] = [];
  const vs: number[] = [];
  let sx = 0, sy = 0, r = 0, g = 0, b = 0;
  for (const i of sel) {
    const rad = (p.H[i]! * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
    ss.push(p.S[i]!);
    vs.push(p.V[i]!);
    r += img.data[i * img.channels]!;
    g += img.data[i * img.channels + 1]!;
    b += img.data[i * img.channels + 2]!;
  }
  let hMean = h0;
  let sigmaH = 8;
  let sMed = opts.bgSample?.s ?? 0.6;
  let sSigma = 0.08;
  let vMed = opts.bgSample?.v ?? 0.5;
  let rgb: [number, number, number] = [60, 150, 70];
  if (sel.length >= 8) {
    hMean = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
    for (const i of sel) hs.push(circDist(p.H[i]!, hMean));
    sigmaH = 1.25 * (hs.reduce((a, x) => a + x, 0) / hs.length);
    sMed = median(ss);
    sSigma = 1.4826 * median(ss.map((x) => Math.abs(x - sMed)));
    vMed = median(vs);
    rgb = [r / sel.length, g / sel.length, b / sel.length];
  }
  if (opts.bgSample) {
    // a calibrated sample overrides the estimated centre but keeps the measured spread
    hMean = opts.bgSample.h;
    sMed = opts.bgSample.s;
    vMed = opts.bgSample.v;
    const c = hsvToRgb(hMean, sMed, vMed);
    rgb = sel.length >= 8 ? rgb : c;
  }

  const plane =
    sel.length >= 12
      ? fitPlane(
          sel.map((i) => (i % w) / w),
          sel.map((i) => Math.floor(i / w) / h),
          vs,
        )
      : null;
  const vFit: [number, number, number] = plane ? [plane[0], clamp(plane[1], -0.5, 0.5), clamp(plane[2], -0.5, 0.5)] : [vMed, 0, 0];

  const f = sensitivityFactor(opts.sensitivity);
  return {
    h: hMean,
    s: sMed,
    v: vMed,
    rgb,
    hueTol: clamp((10 + 2.5 * sigmaH) * f, 8, 48),
    satLow: clamp((sMed * 0.45) / f, 0.06, 0.45),
    satTolLow: clamp((0.1 + 2.5 * sSigma) * f, 0.1, 0.5),
    satTolHigh: clamp((0.16 + 2.5 * sSigma) * f, 0.16, 0.7),
    shadowMin: clamp(0.45 / Math.sqrt(f), 0.28, 0.62),
    brightMax: 1.3 * Math.sqrt(f),
    vFit,
    coverage,
    calibrated,
  };
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Foreground likelihood (0 = background, 1 = book) of one pixel from colour only.
 * `u`, `t` are the pixel's position in 0..1 (the background brightness varies across the frame).
 */
export function scoreColor(h: number, s: number, v: number, u: number, t: number, m: BgModel): number {
  const d = scoreParts(h, s, v, u, t, m);
  return Math.max(d.core, d.dark);
}

/**
 * `core` = the colour leaves the backdrop's hue/saturation/brightness-from-above; `dark` = the pixel is much darker than
 * the backdrop. A dark pixel with the backdrop's chroma is either the book's dark cover or the backdrop in the book's
 * shadow — colour cannot tell them apart, so segmentSteps decides that from the shape (see `shadowComponents`).
 */
export function scoreParts(h: number, s: number, v: number, u: number, t: number, m: BgModel): { core: number; dark: number } {
  const dh = circDist(h, m.h);
  const hueFg = smoothstep(m.hueTol, m.hueTol * 1.7, dh);
  const satFg = 1 - smoothstep(m.satLow * 0.6, m.satLow, s);
  const ds = s - m.s;
  const satDev = ds < 0 ? smoothstep(m.satTolLow, m.satTolLow * 1.7, -ds) : smoothstep(m.satTolHigh, m.satTolHigh * 1.7, ds);
  const vfit = clamp(m.vFit[0] + m.vFit[1] * u + m.vFit[2] * t, 0.08, 1);
  const ratio = v / vfit;
  const bright = smoothstep(m.brightMax, m.brightMax * 1.35, ratio);
  const dark = Math.max(1 - smoothstep(0.035, 0.09, v), 1 - smoothstep(m.shadowMin * 0.85, m.shadowMin * 1.2, ratio));
  return { core: Math.max(hueFg, satFg, satDev, bright), dark };
}

/**
 * Backdrop in the book's shadow vs. a dark cover of the same green: both are dark with the backdrop's chroma. A shadow
 * fades into the lit backdrop gradually; a cover ends in a sharp step. Components of "dark with backdrop chroma" whose
 * border towards the lit backdrop is a gentle ramp are shadow. Returns the pixels to treat as backdrop.
 */
function shadowComponents(core: Float32Array, dark: Float32Array, V: Float32Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const cand = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (core[i]! < 0.35 && dark[i]! > 0.05 && V[i]! >= 0.06) {
      cand[i] = 1;
      any = true;
    }
  }
  const out = new Uint8Array(n);
  if (!any) return out;
  const comps = labelComponents(cand, w, h);
  const BINS = 24;
  const MAX_STEP = 0.4;
  const hist = new Uint32Array((comps.count + 1) * BINS);
  const border = new Uint32Array(comps.count + 1);
  const bump = (c: number, p: number, q: number) => {
    // q: a pixel with the backdrop's chroma that is not darkness-driven → the lit backdrop
    if (cand[q] || core[q]! >= 0.35) return;
    const step = Math.abs(V[p]! - V[q]!);
    hist[c * BINS + Math.min(BINS - 1, Math.floor((step / MAX_STEP) * BINS))]!++;
    border[c]!++;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!cand[p]) continue;
      const c = comps.labels[p]!;
      if (x > 0) bump(c, p, p - 1);
      if (x < w - 1) bump(c, p, p + 1);
      if (y > 0) bump(c, p, p - w);
      if (y < h - 1) bump(c, p, p + w);
    }
  }
  const isShadow = new Uint8Array(comps.count + 1);
  for (let c = 1; c <= comps.count; c++) {
    if (border[c]! < 8) continue; // no lit backdrop beside it: leave it to the other rules
    let acc = 0;
    let bin = 0;
    for (; bin < BINS; bin++) {
      acc += hist[c * BINS + bin]!;
      if (acc >= border[c]! / 2) break;
    }
    const medianStep = ((bin + 1) / BINS) * MAX_STEP;
    if (medianStep <= 0.06) isShadow[c] = 1;
  }
  for (let i = 0; i < n; i++) if (cand[i] && isShadow[comps.labels[i]!]) out[i] = 1;
  return out;
}

function rasterizeStrokes(strokes: NonNullable<ManualEdits["strokes"]>, w: number, h: number): Uint8Array {
  const forced = new Uint8Array(w * h);
  const long = Math.max(w, h);
  const disc = (cx: number, cy: number, rad: number, value: number) => {
    const r2 = rad * rad;
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) forced[y * w + x] = value;
      }
    }
  };
  for (const s of strokes) {
    const value = s.mode === "erase" ? 1 : 2;
    const rad = Math.max(1, s.r * long);
    let prev: [number, number] | null = null;
    for (const [px, py] of s.pts) {
      const cx = px * (w - 1);
      const cy = py * (h - 1);
      if (prev) {
        const dist = Math.hypot(cx - prev[0], cy - prev[1]);
        const steps = Math.max(1, Math.ceil(dist / Math.max(1, rad * 0.5)));
        for (let k = 1; k <= steps; k++) disc(prev[0] + ((cx - prev[0]) * k) / steps, prev[1] + ((cy - prev[1]) * k) / steps, rad, value);
      } else {
        disc(cx, cy, rad, value);
      }
      prev = [cx, cy];
    }
  }
  return forced;
}

/** Hysteresis: weak pixels survive only when 8-connected to a strong one. */
function hysteresis(score: Float32Array, w: number, h: number, lo: number, hi: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < score.length; i++) {
    if (score[i]! >= hi) {
      out[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp > 0) {
    const p = stack[--sp]!;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const q = ny * w + nx;
        if (!out[q] && score[q]! >= lo) {
          out[q] = 1;
          stack[sp++] = q;
        }
      }
    }
  }
  return out;
}

function andNot(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

/** A hole larger than this share of the item cannot be told from a printed area by colour alone: it is kept and flagged. */
const MAX_REAL_HOLE_SHARE = 0.06;
const REAL_HOLE_BG_SHARE = 0.85;
const UNCERTAIN_HOLE_BG_SHARE = 0.55;

/**
 * Enclosed areas of the mask ("holes") - decided one by one instead of filling them all.
 *
 * Why: filling every enclosed area was right for a green illustration printed inside a cover, and wrong for the case that
 * matters most on documents: a REAL hole or a missing piece of paper, through which the green surface shows. Those stayed
 * green inside a cut-out item.
 *
 * A hole is real when (nearly) all of its pixels are clearly backdrop by the strict model (the backdrop's hue and
 * saturation, brightness within what the lit / shadowed backdrop can be, no texture) and it is not suspiciously large. A
 * hole that is only partly backdrop-like, or large, is KEPT (nothing is erased on a doubt) and reported as uncertain so a
 * person looks at it. Small specks and everything that is not backdrop-coloured (ink, dark leather, a different green) are
 * filled exactly as before. Pure function of the masks, unit tested.
 */
export function classifyHoles(mask: Uint8Array, backdropLike: Uint8Array, w: number, h: number, forced?: Uint8Array | null): { mask: Uint8Array; report: HoleReport; uncertainMask: Uint8Array } {
  const n = w * h;
  const filled = fillHoles(mask, w, h);
  const holes = new Uint8Array(n);
  for (let i = 0; i < n; i++) holes[i] = filled[i] && !mask[i] ? 1 : 0;
  const comps = labelComponents(holes, w, h);
  const itemArea = countSet(filled);
  const out = filled.slice();
  const uncertainMask = new Uint8Array(n);
  const report: HoleReport = { real: 0, uncertain: 0, filled: 0, realShare: 0 };
  if (comps.count === 0) return { mask: out, report, uncertainMask };
  // per component: pixels, and how many of those that are not on the rim (4-neighbours all in the hole) are backdrop-like
  const inner = new Int32Array(comps.count + 1);
  const innerBg = new Int32Array(comps.count + 1);
  const allBg = new Int32Array(comps.count + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = comps.labels[i]!;
      if (!c) continue;
      if (backdropLike[i]) allBg[c]!++;
      const interior = x > 0 && y > 0 && x < w - 1 && y < h - 1 && comps.labels[i - 1] === c && comps.labels[i + 1] === c && comps.labels[i - w] === c && comps.labels[i + w] === c;
      if (interior) {
        inner[c]!++;
        if (backdropLike[i]) innerBg[c]!++;
      }
    }
  }
  const minArea = Math.max(10, Math.round(0.00004 * n));
  const decision = new Uint8Array(comps.count + 1); // 0 filled, 1 real, 2 uncertain
  for (let c = 1; c <= comps.count; c++) {
    const area = comps.areas[c]!;
    if (area < minArea) {
      report.filled++;
      continue;
    }
    // a hole too thin to have an interior is judged by all of its pixels
    const share = inner[c]! >= 4 ? innerBg[c]! / inner[c]! : allBg[c]! / area;
    if (share >= REAL_HOLE_BG_SHARE && area <= itemArea * MAX_REAL_HOLE_SHARE) decision[c] = 1;
    else if (share >= UNCERTAIN_HOLE_BG_SHARE) decision[c] = 2;
    if (decision[c] === 1) report.real++;
    else if (decision[c] === 2) report.uncertain++;
    else report.filled++;
  }
  let realArea = 0;
  for (let i = 0; i < n; i++) {
    const c = comps.labels[i]!;
    if (!c) continue;
    // a person's brush stroke ("keep this") always wins over the automatic decision
    if (decision[c] === 1 && forced?.[i] !== 2) {
      out[i] = 0;
      realArea++;
    } else if (decision[c] === 2) uncertainMask[i] = 1;
  }
  report.realShare = itemArea ? realArea / itemArea : 0;
  return { mask: out, report, uncertainMask };
}

/** Runs the segmentation in steps; a caller may yield to its event loop between them (see runAsync). */
export function* segmentSteps(img: RgbImage, opts: SegmentOptions): Generator<void, SegmentResult, void> {
  const { width: w, height: h } = img;
  const n = w * h;
  const long = Math.max(w, h);
  const planes = toPlanes(img);
  yield;
  const model = estimateBackground(img, planes, opts);
  yield;

  // local texture (std of luma) — real books are textured, the backdrop is smooth
  const l2 = new Float32Array(n);
  for (let i = 0; i < n; i++) l2[i] = planes.L[i]! * planes.L[i]!;
  const texR = long >= 600 ? 2 : 1;
  const m1 = boxBlur(planes.L, w, h, texR);
  const m2 = boxBlur(l2, w, h, texR);

  const core = new Float32Array(n);
  const darkTerm = new Float32Array(n);
  for (let y = 0, i = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++, i++) {
      const parts = scoreParts(planes.H[i]!, planes.S[i]!, planes.V[i]!, x / w, t, model);
      core[i] = parts.core;
      darkTerm[i] = parts.dark;
    }
  }
  const shadow = shadowComponents(core, darkTerm, planes.V, w, h);
  yield;

  const score = new Float32Array(n);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let sc = shadow[i] ? core[i]! : Math.max(core[i]!, darkTerm[i]!);
      const std = Math.sqrt(Math.max(0, m2[i]! - m1[i]! * m1[i]!));
      const tex = 0.7 * smoothstep(0.06, 0.14, std);
      if (tex > sc) sc = tex;
      score[i] = sc;
    }
  }

  yield;
  const forced = opts.strokes?.length ? rasterizeStrokes(opts.strokes, w, h) : new Uint8Array(n);
  const hasForced = opts.strokes?.length ? true : false;
  if (hasForced) {
    for (let i = 0; i < n; i++) {
      if (forced[i] === 1) score[i] = 0;
      else if (forced[i] === 2) score[i] = 1;
    }
  }

  let mask = hysteresis(score, w, h, 0.38, 0.62);
  yield;

  // Closing bridges small gaps in the item - but never over clear backdrop: a narrow tear or a slit between two pieces of
  // paper shows the green and must stay open (it is part of the real shape of the item).
  const closeR = Math.max(1, Math.round(0.004 * long));
  const closed = erode(dilate(mask, w, h, closeR), w, h, closeR);
  for (let i = 0; i < n; i++) if (closed[i] && !mask[i] && score[i]! < 0.2) closed[i] = 0;
  mask = closed;
  yield;
  // enclosed areas: real holes stay open, everything else is filled (see classifyHoles)
  const backdropLike = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dh = circDist(planes.H[i]!, model.h);
    // strict: the backdrop's own hue and saturation, a brightness the lit or shadowed backdrop can have, and no texture
    backdropLike[i] = score[i]! < 0.2 && dh <= model.hueTol * 0.8 && planes.S[i]! >= model.satLow && planes.V[i]! >= 0.08 ? 1 : 0;
  }
  const holeResult = classifyHoles(mask, backdropLike, w, h, hasForced ? forced : null);
  mask = holeResult.mask;
  const holeReport = holeResult.report;
  if (long >= 160) mask = dilate(erode(mask, w, h, 1), w, h, 1);
  yield;

  // keep the main object (and anything the user explicitly kept)
  const comps = labelComponents(mask, w, h);
  let largest = 0;
  for (let c = 1; c <= comps.count; c++) if (comps.areas[c]! > largest) largest = comps.areas[c]!;
  const keep = new Uint8Array(comps.count + 1);
  let significant = 0;
  for (let c = 1; c <= comps.count; c++) {
    if (comps.areas[c]! >= Math.max(8, largest * 0.04)) {
      keep[c] = 1;
      if (comps.areas[c]! >= largest * 0.1) significant++;
    }
  }
  if (hasForced) {
    for (let i = 0; i < n; i++) if (forced[i] === 2 && comps.labels[i]) keep[comps.labels[i]!] = 1;
  }
  for (let i = 0; i < n; i++) mask[i] = mask[i] && keep[comps.labels[i]!] ? 1 : 0;
  if (hasForced) {
    for (let i = 0; i < n; i++) {
      if (forced[i] === 2) mask[i] = 1;
      else if (forced[i] === 1) mask[i] = 0;
    }
  }

  const area = countSet(mask);
  let bbox: Bbox | null = null;
  if (area > 0) {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        if (mask[i]) {
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
    }
    bbox = { x0, y0, x1, y1 };
  }

  // soft alpha and boundary proximity
  yield;
  const maskF = new Float32Array(n);
  for (let i = 0; i < n; i++) maskF[i] = mask[i]!;
  const soft = boxBlur(maskF, w, h, 1);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = Math.round(soft[i]! * 255);
  const wide = boxBlur(maskF, w, h, Math.max(2, Math.round(0.01 * long)));
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) edge[i] = Math.round((1 - Math.abs(2 * wide[i]! - 1)) * 255);

  // ── quality control ──
  yield;
  const warnings: WarningCode[] = [];
  let confidence = 1;
  const penalty = (amount: number, code: WarningCode) => {
    confidence -= amount;
    if (!warnings.includes(code)) warnings.push(code);
  };
  const areaFraction = area / n;
  if (model.coverage < 0.15) penalty(0.8, "BG_NOT_FOUND");
  else if (model.coverage < 0.35) penalty(0.45, "BG_NOT_FOUND");
  else if (model.coverage < 0.55) confidence -= 0.15;
  if (areaFraction < 0.03) penalty(0.7, "TOO_SMALL");
  else if (areaFraction < 0.08) penalty(0.3, "TOO_SMALL");
  if (areaFraction > 0.97) penalty(0.7, "NO_BACKGROUND");
  else if (areaFraction > 0.92) penalty(0.25, "NO_BACKGROUND");

  let touching = 0;
  let frame = 0;
  for (let x = 0; x < w; x++) {
    frame += 2;
    if (mask[x]) touching++;
    if (mask[(h - 1) * w + x]) touching++;
  }
  for (let y = 1; y < h - 1; y++) {
    frame += 2;
    if (mask[y * w]) touching++;
    if (mask[y * w + w - 1]) touching++;
  }
  const touchesFrame = frame ? touching / frame : 0;
  if (touchesFrame > 0.3) penalty(0.4, "TOUCHES_FRAME");
  else if (touchesFrame > 0.1) penalty(0.25, "TOUCHES_FRAME");

  const bboxArea = bbox ? (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0) : 1;
  const bboxFill = bbox ? area / bboxArea : 0;
  if (bbox && bboxFill < 0.35) penalty(0.3, "SPARSE_SHAPE");
  if (significant > 1) penalty(0.15, "MULTIPLE_OBJECTS");

  // an unambiguous boundary has clear background just outside and clear book just inside
  let ambiguity = 0;
  if (area > 0) {
    const r1 = Math.max(1, Math.round(0.0025 * long));
    const r2 = Math.max(r1 + 1, Math.round(0.006 * long));
    const outer = andNot(dilate(mask, w, h, r2), dilate(mask, w, h, r1));
    const inner = andNot(erode(mask, w, h, r1), erode(mask, w, h, r2));
    let bad = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (forced[i]) continue;
      if (outer[i]) {
        total++;
        if (score[i]! > 0.4) bad++;
      } else if (inner[i]) {
        total++;
        if (score[i]! < 0.6) bad++;
      }
    }
    ambiguity = total ? bad / total : 0;
    if (ambiguity > 0.25) penalty(0.45, "AMBIGUOUS_EDGE");
    else if (ambiguity > 0.12) penalty(0.25, "AMBIGUOUS_EDGE");
  }
  // ── quality control of the RESULT ──
  // 1. a stripe of backdrop green along the edge of the item
  let greenEdge = 0;
  let erasedPart = 0;
  if (area > 0) {
    const rr = Math.max(2, Math.round(0.004 * long));
    const rim = andNot(mask, erode(mask, w, h, rr));
    let rimN = 0;
    let rimGreen = 0;
    for (let i = 0; i < n; i++) {
      if (!rim[i] || forced[i]) continue;
      rimN++;
      if (backdropLike[i] && score[i]! < 0.12) rimGreen++;
    }
    greenEdge = rimN > 40 ? rimGreen / rimN : 0;
    if (greenEdge > 0.2) penalty(0.15, "GREEN_EDGE");
    // 2. clear item colour outside the mask that touches it: a piece of the item was left out
    const lost = new Uint8Array(n);
    const near = dilate(mask, w, h, Math.max(2, Math.round(0.006 * long)));
    for (let i = 0; i < n; i++) if (!mask[i] && near[i] && forced[i] !== 1 && score[i]! >= 0.75 && !shadow[i]) lost[i] = 1;
    const lostComps = labelComponents(lost, w, h);
    let lostArea = 0;
    for (let c = 1; c <= lostComps.count; c++) if (lostComps.areas[c]! >= Math.max(24, Math.round(0.0015 * n))) lostArea += lostComps.areas[c]!;
    erasedPart = lostArea / Math.max(1, area);
    if (erasedPart > 0.01) penalty(0.2, "MASK_ERASED_PART");
  }
  // 3. a green area that may be a hole or printed colour was kept: a person decides
  if (holeReport.uncertain > 0) penalty(0.1, "UNCERTAIN_HOLE");
  if (!bbox) confidence = 0;

  return {
    width: w,
    height: h,
    alpha,
    mask,
    edge,
    forced,
    bbox,
    confidence: clamp(confidence, 0, 1),
    warnings,
    model,
    metrics: { areaFraction, borderCoverage: model.coverage, touchesFrame, bboxFill, ambiguity, greenEdge, erasedPart },
    holes: holeReport,
  };
}

export function segmentBook(img: RgbImage, opts: SegmentOptions): SegmentResult {
  return runSync(segmentSteps(img, opts));
}

/** Median HSV of a small patch around (x, y) — "click on the green" calibration. */
export function sampleBackground(img: RgbImage, x: number, y: number, radius = 4): BgSample {
  const hs: number[] = [];
  const ss: number[] = [];
  const vs: number[] = [];
  let sx = 0, sy = 0;
  for (let yy = Math.max(0, Math.round(y) - radius); yy <= Math.min(img.height - 1, Math.round(y) + radius); yy++) {
    for (let xx = Math.max(0, Math.round(x) - radius); xx <= Math.min(img.width - 1, Math.round(x) + radius); xx++) {
      const o = (yy * img.width + xx) * img.channels;
      const [h, s, v] = rgbToHsv(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
      hs.push(h);
      ss.push(s);
      vs.push(v);
      sx += Math.cos((h * Math.PI) / 180);
      sy += Math.sin((h * Math.PI) / 180);
    }
  }
  return { h: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360, s: median(ss), v: median(vs) };
}
