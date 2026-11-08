import { boxBlur, dilate, labelComponents, smoothstep } from "./raster";

/**
 * Auto deskew: decides whether a photographed item stands visibly crooked and by how much.
 *
 * Only a ROTATION is ever suggested — no perspective correction, no scaling of the corners — so the natural
 * viewpoint of the shot (the bottom of a book looking a little wider than its top) is kept as it is.
 *
 * The angle comes from the shape of the segmentation mask, never from its bounding box: the orientation of every
 * boundary pixel is folded modulo 90° and the dominant direction is the item's tilt. A second, independent
 * estimate (the minimum-area rectangle of the convex hull) must agree. Everything that does not look like exactly
 * one item with a clear outline (compositions, several books at different angles, shapes cut by the frame,
 * deliberately set angles, uncertain detections) is left alone and reported with the reason.
 */

/** Bump when the detection changes in a way that can give a different answer: the batch tool re-examines older results. */
export const DESKEW_ALGO_VERSION = 1;

/** Conservative limits, one place to change them. */
export const DESKEW_LIMITS = {
  /** below this nothing is rotated */
  minConfidence: 0.8,
  /** larger tilts look deliberate (or wrong) and need a human decision */
  maxAutoAngle: 8,
  /** below this the item counts as straight already — no pointless resampling */
  minAngle: 0.5,
  /** the two independent estimates may differ by at most this before the shot is left alone */
  maxEstimateGap: 4,
  /** a second component of at least this share of the largest one makes the shot a composition */
  secondObjectShare: 0.06,
  /** share of the outline that may touch the frame */
  maxFrameContact: 0.04,
} as const;

export type DeskewSkip =
  | "disabled"
  | "manual-edits"
  | "detection-untrusted"
  | "no-object"
  | "multiple-objects"
  | "mixed-directions"
  | "touches-frame"
  | "low-confidence"
  | "estimates-disagree"
  | "already-straight"
  | "angle-too-large"
  /** the straightened picture did not measure straighter than the original: the rotation was dropped */
  | "not-verified";

/** single = one item with one clear direction; composition = several items or mixed directions; unclear = could not tell */
export type DeskewKind = "single" | "composition" | "unclear" | "none";

export interface DeskewDecision {
  kind: DeskewKind;
  /** measured tilt of the item in degrees, clockwise positive (0 when nothing was measured) */
  tilt: number;
  /** rotation to apply, degrees clockwise; 0 when `apply` is false. Equals −tilt. */
  angle: number;
  confidence: number;
  apply: boolean;
  skip: DeskewSkip | null;
  metrics: { peakShare: number; solidity: number; rectFill: number; estimateGap: number; objects: number };
}

const EMPTY_METRICS: DeskewDecision["metrics"] = { peakShare: 0, solidity: 0, rectFill: 0, estimateGap: 0, objects: 0 };

export const skipped = (skip: DeskewSkip, kind: DeskewKind = "none"): DeskewDecision => ({
  kind,
  tilt: 0,
  angle: 0,
  confidence: 0,
  apply: false,
  skip,
  metrics: EMPTY_METRICS,
});

/** what is stored on the processing result of a photo */
export interface DeskewInfo {
  algo: number;
  kind: DeskewKind;
  tilt: number;
  angle: number;
  confidence: number;
  applied: boolean;
  skip: DeskewSkip | null;
}

export function deskewInfo(d: DeskewDecision): DeskewInfo {
  return {
    algo: DESKEW_ALGO_VERSION,
    kind: d.kind,
    tilt: round(d.tilt, 2),
    angle: round(d.angle, 2),
    confidence: round(d.confidence, 2),
    applied: d.apply,
    skip: d.skip,
  };
}

const round = (x: number, d: number) => Number(x.toFixed(d));
/** folds any angle into [−45, 45) — the tilt of a shape with 90° symmetry */
const fold90 = (deg: number) => ((((deg + 45) % 90) + 90) % 90) - 45;

const BIN = 0.25;
const BINS = 360; // [−45, 45)
const PEAK_HALF = 4;
const MEAN_HALF = 5;
const BLUR = 4;

/**
 * @param mask   binary foreground (1 = item) of the working copy
 * @param alpha  its soft matte (0..255) — the anti-aliased edge gives sub-pixel direction; a binary staircase would bias small angles
 * @param opts.minConfidence override of {@link DESKEW_LIMITS}.minConfidence (tests, tuning)
 */
export function decideDeskew(mask: Uint8Array, alpha: Uint8Array | null, w: number, h: number, opts: { minConfidence?: number; maxAutoAngle?: number } = {}): DeskewDecision {
  const L = DESKEW_LIMITS;
  const minConfidence = opts.minConfidence ?? L.minConfidence;
  const maxAuto = opts.maxAutoAngle ?? L.maxAutoAngle;

  const comps = labelComponents(mask, w, h);
  if (comps.count === 0) return skipped("no-object");
  let main = 1;
  for (let i = 2; i <= comps.count; i++) if (comps.areas[i]! > comps.areas[main]!) main = i;
  const area = comps.areas[main]!;
  if (area < w * h * 0.01) return skipped("no-object");
  let objects = 1;
  for (let i = 1; i <= comps.count; i++) if (i !== main && comps.areas[i]! >= area * L.secondObjectShare) objects++;
  if (objects > 1) return { ...skipped("multiple-objects", "composition"), metrics: { ...EMPTY_METRICS, objects } };

  const only = new Uint8Array(w * h);
  const boundary: [number, number][] = [];
  let frameContact = 0;
  for (let i = 0; i < only.length; i++) if (comps.labels[i] === main) only[i] = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!only[i]) continue;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !only[i - 1]! || !only[i + 1]! || !only[i - w]! || !only[i + w]!;
      if (!edge) continue;
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) frameContact++;
      else boundary.push([x, y]);
    }
  }
  if (boundary.length < 40) return skipped("no-object");
  if (frameContact / (boundary.length + frameContact) > L.maxFrameContact) return skipped("touches-frame", "unclear");

  // ---- estimate 1: dominant outline direction (mod 90°), from the gradient of the blurred mask
  const f = new Float32Array(w * h);
  if (alpha) {
    const near = dilate(only, w, h, 4);
    for (let i = 0; i < f.length; i++) f[i] = near[i] ? alpha[i]! / 255 : 0;
  } else {
    for (let i = 0; i < f.length; i++) f[i] = only[i]!;
  }
  const g = boxBlur(f, w, h, BLUR);
  const hist = new Float64Array(BINS);
  let total = 0;
  const normals: { x: number; y: number; theta: number }[] = [];
  for (const [x, y] of boundary) {
    const i = y * w + x;
    const gx = g[i + 1]! - g[i - 1]!;
    const gy = g[i + w]! - g[i - w]!;
    const mag = Math.hypot(gx, gy);
    if (mag < 0.02) continue;
    const theta = (Math.atan2(gy, gx) * 180) / Math.PI;
    normals.push({ x, y, theta });
    const t = fold90(theta);
    hist[Math.min(BINS - 1, Math.floor((t + 45) / BIN))]! += mag;
    total += mag;
  }
  if (total === 0) return skipped("no-object");
  const at = (b: number) => hist[((b % BINS) + BINS) % BINS]!;
  const half = Math.round(PEAK_HALF / BIN);
  let bestBin = 0;
  let best = -1;
  let run = 0;
  for (let b = -half; b <= half; b++) run += at(b);
  for (let b = 0; b < BINS; b++) {
    if (run > best) {
      best = run;
      bestBin = b;
    }
    run += at(b + half + 1) - at(b - half);
  }
  const centre = bestBin * BIN - 45 + BIN / 2;
  let wsum = 0;
  let dsum = 0;
  const meanHalf = Math.round(MEAN_HALF / BIN);
  for (let b = bestBin - meanHalf; b <= bestBin + meanHalf; b++) {
    wsum += at(b);
    dsum += at(b) * (b - bestBin) * BIN;
  }
  const coarseTilt = fold90(centre + (wsum > 0 ? dsum / wsum : 0));
  const peakShare = wsum / total;
  const histTilt = refineBySides(normals, coarseTilt) ?? coarseTilt;

  // ---- estimate 2: minimum-area rectangle of the convex hull
  const hull = convexHull(boundary);
  const hullArea = polygonArea(hull);
  let minArea = Infinity;
  let minPsi = 0;
  for (let psi = -45; psi < 45; psi += BIN) {
    const c = Math.cos((psi * Math.PI) / 180);
    const s = Math.sin((psi * Math.PI) / 180);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [px, py] of hull) {
      const rx = px * c - py * s;
      const ry = px * s + py * c;
      if (rx < x0) x0 = rx;
      if (rx > x1) x1 = rx;
      if (ry < y0) y0 = ry;
      if (ry > y1) y1 = ry;
    }
    const a = (x1 - x0) * (y1 - y0);
    if (a < minArea) {
      minArea = a;
      minPsi = psi;
    }
  }
  const rectTilt = fold90(-minPsi);
  const solidity = Math.min(1, area / Math.max(1, hullArea));
  const rectFill = Math.min(1, area / Math.max(1, minArea));
  const gap = Math.abs(fold90(histTilt - rectTilt));

  const metrics = { peakShare: round(peakShare, 3), solidity: round(solidity, 3), rectFill: round(rectFill, 3), estimateGap: round(gap, 2), objects };
  if (peakShare < 0.6) return { ...skipped("mixed-directions", "composition"), metrics };

  const confidence = Math.min(
    smoothstep(0.6, 0.85, peakShare),
    smoothstep(0.86, 0.95, solidity),
    smoothstep(0.78, 0.9, rectFill),
    1 - smoothstep(1.5, L.maxEstimateGap, gap),
  );
  const base = { kind: "single" as const, tilt: histTilt, confidence, metrics };
  const no = (skip: DeskewSkip): DeskewDecision => ({ ...base, angle: 0, apply: false, skip });

  if (gap > L.maxEstimateGap) return no("estimates-disagree");
  if (confidence < minConfidence) return no("low-confidence");
  if (Math.abs(histTilt) < L.minAngle) return no("already-straight");
  if (Math.abs(histTilt) > maxAuto) return no("angle-too-large");
  return { ...base, angle: round(-histTilt, 2), apply: true, skip: null };
}

/**
 * Sub-pixel refinement of the coarse direction: the boundary pixels whose normal points along one of the four sides
 * are fitted with a straight line each (least squares), and the tilt is the length-weighted mean of the sides.
 * A gradient histogram alone is limited to ~0.4° by the pixel grid; a line through a few hundred edge pixels is not.
 * Opposite sides of a book shot from the front lean in opposite directions, so their mean is the overall direction.
 * Wavy or broken sides (open pages, chipped edges) do not fit a line and simply do not vote.
 */
function refineBySides(normals: { x: number; y: number; theta: number }[], coarse: number): number | null {
  const groups: { x: number; y: number }[][] = [[], [], [], []];
  for (const n of normals) {
    const rel = n.theta - coarse;
    const d = fold90(rel);
    if (Math.abs(d) > 6) continue;
    groups[((Math.round(rel / 90) % 4) + 4) % 4]!.push(n);
  }
  let wTotal = 0;
  let tTotal = 0;
  groups.forEach((pts, q) => {
    if (pts.length < 30) return;
    const vertical = q % 2 === 0; // normals along x → the side runs along y
    const u = pts.map((p) => (vertical ? p.y : p.x));
    const v = pts.map((p) => (vertical ? p.x : p.y));
    const mu = u.reduce((a, b) => a + b, 0) / u.length;
    const mv = v.reduce((a, b) => a + b, 0) / v.length;
    let suu = 0;
    let suv = 0;
    for (let i = 0; i < u.length; i++) {
      suu += (u[i]! - mu) ** 2;
      suv += (u[i]! - mu) * (v[i]! - mv);
    }
    const span = Math.sqrt((suu / u.length) * 12); // length of the side (uniform spread)
    if (span < 30 || suu === 0) return;
    const slope = suv / suu;
    let sse = 0;
    for (let i = 0; i < u.length; i++) sse += (v[i]! - mv - slope * (u[i]! - mu)) ** 2;
    if (Math.sqrt(sse / u.length) > 1.2) return; // not a straight side
    const tilt = ((vertical ? -Math.atan(slope) : Math.atan(slope)) * 180) / Math.PI;
    wTotal += span;
    tTotal += span * tilt;
  });
  return wTotal > 0 ? tTotal / wTotal : null;
}

/** Andrew's monotone chain. */
function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j]![0] + p[i]![0]) * (p[j]![1] - p[i]![1]);
  return Math.abs(a / 2);
}
