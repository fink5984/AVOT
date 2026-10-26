import "server-only";
import sharp from "sharp";
import {
  effectiveFormat,
  parseHexColor,
  residualRotation,
  type ManualEdits,
  type PhotoProcessing,
  type ProcessingSettings,
  type Rotation,
} from "@/lib/imaging/settings";
import { runAsync, type Pixels } from "@/lib/imaging/raster";
import { segmentSteps, type Bbox, type SegmentResult, type WarningCode } from "@/lib/imaging/segment";
import { alphaBounds, composeOutputSteps, refineAlphaSteps, withMargin } from "@/lib/imaging/compose";

/**
 * Orientation → background removal → crop → encode, for one photograph.
 *
 * "preview" works on a ≤1800 px copy and is fast enough to run right after
 * the upload; "full" repeats the decision on the working copy but places the
 * edge, the crop and the output at the original resolution. Neither stage
 * ever changes the stored original — callers only receive new bytes.
 */

export const WORKING_LONG_EDGE = 1200;

/** The preview stage and the full stage of one photo segment the same working copy: keep the last few results. */
const segCache = new Map<string, SegmentResult>();
function cachePut(key: string, r: SegmentResult) {
  segCache.delete(key);
  segCache.set(key, r);
  while (segCache.size > 4) segCache.delete(segCache.keys().next().value as string);
}

export type ProcessStage = "preview" | "full";

export interface BookResult {
  /** DONE = processed as configured; NEEDS_REVIEW = detection not trusted, only rotated */
  status: "DONE" | "NEEDS_REVIEW";
  data: Buffer;
  mime: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
  width: number;
  height: number;
  hasAlpha: boolean;
  confidence: number;
  warnings: WarningCode[];
  /** book bounds, normalised to the rotated image (null when nothing was found) */
  bounds: { x: number; y: number; w: number; h: number } | null;
  applied: { rotation: Rotation; backgroundRemoved: boolean; cropped: boolean };
  stage: ProcessStage;
  ms: number;
}

/** EXIF-oriented, sRGB, rotated by `residual` — both steps run natively in libvips, off the event loop. */
async function readOriented(input: Buffer, longEdge: number | null, residual: Rotation) {
  let p = sharp(input, { failOn: "error" }).rotate();
  if (longEdge) p = p.resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });
  const first = await p.toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (residual === 0) return { data: first.data as Pixels, width: first.info.width, height: first.info.height };
  const turned = await sharp(first.data, { raw: { width: first.info.width, height: first.info.height, channels: 3 } })
    .rotate(residual)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: turned.data as Pixels, width: turned.info.width, height: turned.info.height };
}

async function upscale(map: Uint8Array, w: number, h: number, toW: number, toH: number, kernel: "cubic" | "nearest"): Promise<Uint8Array> {
  if (w === toW && h === toH) return map;
  const { data, info } = await sharp(Buffer.from(map.buffer, map.byteOffset, map.length), { raw: { width: w, height: h, channels: 1 } })
    .resize(toW, toH, { fit: "fill", kernel })
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return new Uint8Array(data.buffer, data.byteOffset, data.length);
  // sharp may hand back several identical channels for a grey map — keep the first
  const one = new Uint8Array(info.width * info.height);
  for (let i = 0; i < one.length; i++) one[i] = data[i * info.channels]!;
  return one;
}

async function encode(
  data: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
  s: ProcessingSettings,
  stage: ProcessStage,
): Promise<{ data: Buffer; mime: BookResult["mime"]; ext: BookResult["ext"] }> {
  const raw = sharp(Buffer.from(data.buffer, data.byteOffset, data.length), { raw: { width, height, channels } });
  if (effectiveFormat(s) === "png") {
    return { data: await raw.png({ compressionLevel: stage === "full" ? 6 : 3 }).toBuffer(), mime: "image/png", ext: "png" };
  }
  const q = stage === "full" ? s.jpegQuality : Math.min(s.jpegQuality, 88);
  return { data: await raw.jpeg({ quality: q, mozjpeg: stage === "full", chromaSubsampling: "4:4:4" }).toBuffer(), mime: "image/jpeg", ext: "jpg" };
}

/** Oriented, rotated JPEG used by the correction editor (same orientation the server will process). */
export async function editSourceJpeg(input: Buffer, rotation: Rotation, longEdge = 1400): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const res = residualRotation(meta.orientation, rotation);
  const raw = await readOriented(input, longEdge, res);
  return sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.length), { raw: { width: raw.width, height: raw.height, channels: 3 } })
    .jpeg({ quality: 88 })
    .toBuffer();
}

export async function processBook(input: Buffer, processing: PhotoProcessing, stage: ProcessStage, cacheKey?: string): Promise<BookResult> {
  return exclusive(() => processBookNow(input, processing, stage, cacheKey));
}

/** One photo at a time per process: bounds memory (a 33 MP frame is ~300 MB at its peak) and keeps the web server responsive during a burst of uploads. */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function processBookNow(input: Buffer, processing: PhotoProcessing, stage: ProcessStage, cacheKey?: string): Promise<BookResult> {
  const started = Date.now();
  const s = processing.settings;
  const edits: ManualEdits = processing.edits ?? {};
  const meta = await sharp(input, { failOn: "error" }).metadata();
  const residual = residualRotation(meta.orientation, s.rotation);

  const background: [number, number, number] | null = s.background === "transparent" ? null : parseHexColor(s.background);
  const wantsSegmentation = s.removeBackground || s.autoCrop || !!edits.crop;

  const load = (long: number | null) => readOriented(input, long, residual);

  const base = { stage, applied: { rotation: s.rotation, backgroundRemoved: false, cropped: false } };
  const rotatedOnly = async (img: { data: Pixels; width: number; height: number }, seg: SegmentResult | null, status: BookResult["status"]): Promise<BookResult> => {
    // rotation only — a flat RGB copy, nothing removed or cut away
    const out = await encode(img.data as Uint8Array, img.width, img.height, 3, { ...s, background: s.background === "transparent" ? "#ffffff" : s.background }, stage);
    return {
      status,
      ...out,
      width: img.width,
      height: img.height,
      hasAlpha: false,
      confidence: seg?.confidence ?? 1,
      warnings: seg?.warnings ?? [],
      bounds: seg?.bbox ? norm(seg.bbox, seg.width, seg.height) : null,
      ...base,
      ms: Date.now() - started,
    };
  };

  const working = await load(WORKING_LONG_EDGE);
  if (!wantsSegmentation) return rotatedOnly(stage === "full" ? await load(null) : working, null, "DONE");

  const seg =
    (cacheKey ? segCache.get(cacheKey) : undefined) ??
    (await runAsync(
      segmentSteps({ data: working.data, width: working.width, height: working.height, channels: 3 }, { sensitivity: s.sensitivity, bgSample: s.bgSample, strokes: edits.strokes }),
    ));
  if (cacheKey) cachePut(cacheKey, seg);
  const trusted = seg.bbox !== null && (seg.confidence >= s.minConfidence || edits.confirmed === true);
  if (!trusted) return rotatedOnly(stage === "full" ? await load(null) : working, seg, "NEEDS_REVIEW");

  const bounds = norm(seg.bbox!, seg.width, seg.height);
  const result = (o: { data: Buffer; mime: BookResult["mime"]; ext: BookResult["ext"] }, w: number, h: number, hasAlpha: boolean, cropped: boolean): BookResult => ({
    status: "DONE",
    ...o,
    width: w,
    height: h,
    hasAlpha,
    confidence: seg.confidence,
    warnings: seg.warnings,
    bounds,
    stage,
    applied: { rotation: s.rotation, backgroundRemoved: s.removeBackground, cropped },
    ms: Date.now() - started,
  });

  if (stage === "preview") {
    const W = working.width;
    const H = working.height;
    const crop = pickCrop(edits, s, seg.bbox!, W, H);
    const rgb = { rgb: working.data, width: W, height: H, channels: 3 as const };
    if (s.removeBackground) {
      const out = await runAsync(composeOutputSteps({ ...rgb, alpha: seg.alpha, edge: seg.edge, model: seg.model, background, crop }));
      const enc = await encode(out.data, out.width, out.height, out.channels, s, stage);
      return result(enc, out.width, out.height, out.channels === 4, crop.w !== W || crop.h !== H);
    }
    const sub = cropRgb(working.data, W, crop);
    const enc = await encode(sub, crop.w, crop.h, 3, s, stage);
    return result(enc, crop.w, crop.h, false, crop.w !== W || crop.h !== H);
  }

  // full resolution
  const full = await load(null);
  const W = full.width;
  const H = full.height;
  const sx = W / seg.width;
  const sy = H / seg.height;
  const pad = Math.ceil(Math.max(sx, sy) * 2) + 2;
  const region = {
    x: Math.max(0, Math.floor(seg.bbox!.x0 * sx) - pad),
    y: Math.max(0, Math.floor(seg.bbox!.y0 * sy) - pad),
    w: 0,
    h: 0,
  };
  region.w = Math.min(W, Math.ceil(seg.bbox!.x1 * sx) + pad) - region.x;
  region.h = Math.min(H, Math.ceil(seg.bbox!.y1 * sy) + pad) - region.y;

  const alphaUp = await upscale(seg.alpha, seg.width, seg.height, W, H, "cubic");
  const forcedUp = edits.strokes?.length ? await upscale(seg.forced, seg.width, seg.height, W, H, "nearest") : null;
  const fullImg = { rgb: full.data, width: W, height: H, channels: 3 as const };
  const alpha = await runAsync(refineAlphaSteps(fullImg, alphaUp, forcedUp, seg.model));
  const tight = alphaBounds(alpha, W, H, region) ?? { x0: region.x, y0: region.y, x1: region.x + region.w, y1: region.y + region.h };
  const crop = pickCrop(edits, s, tight, W, H);

  if (!s.removeBackground) {
    const sub = cropRgb(full.data, W, crop);
    const enc = await encode(sub, crop.w, crop.h, 3, s, stage);
    return result(enc, crop.w, crop.h, false, crop.w !== W || crop.h !== H);
  }
  const edgeUp = await upscale(seg.edge, seg.width, seg.height, W, H, "cubic");
  const out = await runAsync(composeOutputSteps({ ...fullImg, alpha, edge: edgeUp, model: seg.model, background, crop }));
  const enc = await encode(out.data, out.width, out.height, out.channels, s, stage);
  return result(enc, out.width, out.height, out.channels === 4, crop.w !== W || crop.h !== H);
}

function norm(b: Bbox, w: number, h: number) {
  return { x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0) / w, h: (b.y1 - b.y0) / h };
}

/** manual crop > automatic tight crop (+ margin) > whole image */
function pickCrop(edits: ManualEdits, s: ProcessingSettings, bbox: Bbox, W: number, H: number) {
  if (edits.crop) {
    const x = Math.min(W - 1, Math.round(edits.crop.x * W));
    const y = Math.min(H - 1, Math.round(edits.crop.y * H));
    return { x, y, w: Math.max(1, Math.min(W - x, Math.round(edits.crop.w * W))), h: Math.max(1, Math.min(H - y, Math.round(edits.crop.h * H))) };
  }
  if (!s.autoCrop) return { x: 0, y: 0, w: W, h: H };
  return withMargin(bbox, s.marginPct, W, H);
}

function cropRgb(data: Pixels, W: number, c: { x: number; y: number; w: number; h: number }): Uint8Array {
  const out = new Uint8Array(c.w * c.h * 3);
  for (let y = 0; y < c.h; y++) {
    const s = ((c.y + y) * W + c.x) * 3;
    out.set(data.subarray(s, s + c.w * 3), y * c.w * 3);
  }
  return out;
}
