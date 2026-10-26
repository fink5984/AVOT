/**
 * Small, dependency-free raster helpers (typed arrays only) used by the book
 * segmentation. They run unchanged in the browser (live preview) and on the
 * server (final processing).
 */

export type Pixels = Uint8Array | Uint8ClampedArray;

export interface RgbImage {
  data: Pixels;
  width: number;
  height: number;
  /** 3 = RGB, 4 = RGBA (alpha ignored) */
  channels: 3 | 4;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = (x - e0) / (e1 - e0);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Rotates interleaved pixel data clockwise by a multiple of 90°. */
export function rotatePixels(src: Pixels, width: number, height: number, channels: number, angle: 0 | 90 | 180 | 270) {
  if (angle === 0) return { data: src, width, height };
  const swap = angle !== 180;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number;
      let ny: number;
      if (angle === 90) {
        nx = height - 1 - y;
        ny = x;
      } else if (angle === 180) {
        nx = width - 1 - x;
        ny = height - 1 - y;
      } else {
        nx = y;
        ny = width - 1 - x;
      }
      const s = (y * width + x) * channels;
      const d = (ny * w + nx) * channels;
      for (let c = 0; c < channels; c++) out[d + c] = src[s + c]!;
    }
  }
  return { data: out, width: w, height: h };
}

/** Box blur of a float map with a (2r+1)² window; edges use the available pixels only. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) {
      sum += src[row + x]!;
      count++;
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / count;
      const add = x + r + 1;
      const rem = x - r;
      if (add < w) {
        sum += src[row + add]!;
        count++;
      }
      if (rem >= 0) {
        sum -= src[row + rem]!;
        count--;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) {
      sum += tmp[y * w + x]!;
      count++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / count;
      const add = y + r + 1;
      const rem = y - r;
      if (add < h) {
        sum += tmp[add * w + x]!;
        count++;
      }
      if (rem >= 0) {
        sum -= tmp[rem * w + x]!;
        count--;
      }
    }
  }
  return out;
}

/** Binary dilation with a (2r+1)² square. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const line = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // distance to the nearest set pixel to the left / right within the row
    let last = -Infinity;
    const left = line;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) last = x;
      left[x] = last === -Infinity ? -1 : last;
    }
    let next = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[row + x]) next = x;
      const l = left[x]!;
      if ((l >= 0 && x - l <= r) || (next !== Infinity && next - x <= r)) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    const up = line;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      up[y] = last === -Infinity ? -1 : last;
    }
    let next = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) next = y;
      const u = up[y]!;
      if ((u >= 0 && y - u <= r) || (next !== Infinity && next - y <= r)) out[y * w + x] = 1;
    }
  }
  return out;
}

export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

export interface Components {
  labels: Int32Array;
  /** area per label; index 0 is unused */
  areas: number[];
  count: number;
}

/** 8-connected components of the set pixels. */
export function labelComponents(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h);
  const areas: number[] = [0];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    count++;
    let area = 0;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = count;
    while (sp > 0) {
      const p = stack[--sp]!;
      area++;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = count;
            stack[sp++] = q;
          }
        }
      }
    }
    areas.push(area);
  }
  return { labels, areas, count };
}

/**
 * Sets every unset pixel that cannot reach the image border (4-connected) —
 * enclosed "holes" such as green illustrations inside the book.
 */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p: number) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const p = stack[--sp]!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

export function countSet(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Drives a stepped computation to completion without yielding. */
export function runSync<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Drives a stepped computation, giving the event loop a turn between steps (keeps a server responsive). */
export async function runAsync<T>(steps: Generator<void, T, void>, tick: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve))): Promise<T> {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    await tick();
  }
}

