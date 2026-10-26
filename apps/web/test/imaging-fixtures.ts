import { hsvToRgb } from "@/lib/imaging/segment";

/** Deterministic synthetic "book on a green table" scenes for the imaging tests. */

export type Rgb = [number, number, number];
export type Poly = [number, number][];

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roundedRect(x: number, y: number, w: number, h: number, r: number, n = 12): Poly {
  const pts: Poly = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

/** Two pages with wavy outer edges, as an open book seen from above. */
export function openBook(cx: number, cy: number, w: number, h: number, wave = 8): Poly {
  const pts: Poly = [];
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push([x0 + u * w, y0 + wave * Math.sin(u * Math.PI * 2) - wave * 1.2 * Math.sin(u * Math.PI)]);
  }
  for (let i = 0; i <= steps; i++) {
    const u = 1 - i / steps;
    pts.push([x0 + u * w + (i === 0 ? 0 : 0), y0 + h + wave * 0.7 * Math.sin(u * Math.PI * 3) + wave * Math.sin(u * Math.PI)]);
  }
  return pts;
}

/** Irregular outline: vertices jittered, one corner cut, small nibbles on the edges. */
export function wornBook(x: number, y: number, w: number, h: number, seed: number): Poly {
  const rand = rng(seed);
  const pts: Poly = [];
  const edge = (ax: number, ay: number, bx: number, by: number, segs: number) => {
    for (let i = 0; i < segs; i++) {
      const u = i / segs;
      const j = (rand() - 0.5) * 5;
      pts.push([ax + (bx - ax) * u + j, ay + (by - ay) * u + j * 0.6]);
    }
  };
  edge(x + 28, y, x + w, y, 24);
  edge(x + w, y, x + w, y + h - 20, 30);
  edge(x + w, y + h - 20, x + w - 20, y + h, 3); // chipped corner
  edge(x + w - 20, y + h, x, y + h, 24);
  edge(x, y + h, x, y, 30);
  edge(x, y, x + 28, y, 3); // cut-off corner
  return pts;
}

function inside(poly: Poly, px: number, py: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export interface SceneOptions {
  width: number;
  height: number;
  /** outline of the book */
  outline: Poly;
  /** colour of the book at a pixel */
  fill: (x: number, y: number) => Rgb;
  /** background colour (HSV) */
  bg?: [number, number, number];
  noise?: number;
  vignette?: number;
  /** soft shadow around the book: offset, blur radius px and darkness 0..1 */
  shadow?: { dx: number; dy: number; blur: number; strength: number };
  /** areas inside the outline painted exactly in the background colour (green illustration) */
  greenInside?: Poly[];
  seed?: number;
}

export interface Scene {
  width: number;
  height: number;
  rgb: Uint8Array;
  /** ground truth: 1 inside the book */
  truth: Uint8Array;
}

export function renderScene(o: SceneOptions): Scene {
  const { width: w, height: h } = o;
  const rand = rng(o.seed ?? 1);
  const bgHsv = o.bg ?? [120, 0.62, 0.55];
  const truth = new Uint8Array(w * h);
  const coverage = new Float32Array(w * h);
  // 2×2 supersampled coverage for anti-aliased edges
  const bbox = o.outline.reduce(
    (b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  for (let y = Math.max(0, Math.floor(bbox.y0) - 1); y < Math.min(h, Math.ceil(bbox.y1) + 1); y++) {
    for (let x = Math.max(0, Math.floor(bbox.x0) - 1); x < Math.min(w, Math.ceil(bbox.x1) + 1); x++) {
      let c = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) if (inside(o.outline, x + ox, y + oy)) c++;
      coverage[y * w + x] = c / 4;
      truth[y * w + x] = c >= 2 ? 1 : 0;
    }
  }

  // shadow = blurred, shifted coverage
  let shade: Float32Array | null = null;
  if (o.shadow) {
    const sh = new Float32Array(w * h);
    const { dx, dy } = o.shadow;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) sh[y * w + x] = coverage[sy * w + sx]!;
    }
    shade = blur(sh, w, h, o.shadow.blur);
  }

  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.hypot(x / w - 0.5, y / h - 0.5);
      let v = bgHsv[2] * (1 - (o.vignette ?? 0.25) * d * 1.2);
      if (shade) v *= 1 - o.shadow!.strength * shade[i]!;
      const bg = hsvToRgb(bgHsv[0], bgHsv[1], Math.max(0.05, v));
      let [r, g, b] = o.fill(x, y);
      if (o.greenInside?.some((p) => inside(p, x + 0.5, y + 0.5)) && coverage[i] === 1) [r, g, b] = hsvToRgb(bgHsv[0], bgHsv[1], bgHsv[2] * 0.95);
      const a = coverage[i]!;
      const nz = (o.noise ?? 0.012) * 255;
      const n1 = (rand() + rand() + rand() - 1.5) * nz * 1.6;
      rgb[i * 3] = clamp8(r * a + bg[0] * (1 - a) + n1);
      rgb[i * 3 + 1] = clamp8(g * a + bg[1] * (1 - a) + n1 * 0.9);
      rgb[i * 3 + 2] = clamp8(b * a + bg[2] * (1 - a) + n1 * 0.9);
    }
  }
  return { width: w, height: h, rgb, truth };
}

const clamp8 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let cur = src;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const k = Math.max(1, Math.round(r / 2));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dx = -k; dx <= k; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) { s += cur[y * w + xx]!; c++; } }
      tmp[y * w + x] = s / c;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -k; dy <= k; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]!; c++; } }
      out[y * w + x] = s / c;
    }
    cur = out;
  }
  return cur;
}

/** Brown leather cover with gold stripes. */
export const leatherFill = (x0: number, y0: number): ((x: number, y: number) => Rgb) => (x, y) => {
  const stripe = Math.floor((y - y0) / 14) % 6 === 0 && x > x0 + 40;
  return stripe ? [196, 162, 84] : [96 + ((x + y) % 7), 58, 38];
};

export const creamFill = (cx: number): ((x: number, y: number) => Rgb) => (x, y) => {
  const gutter = Math.abs(x - cx) < 5;
  const text = (Math.floor(y / 11) % 2 === 0 && Math.abs(x - cx) > 25) ? 0.8 : 1;
  return gutter ? [150, 138, 112] : [246 * text, 238 * text, 218 * text];
};

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 1;
}
