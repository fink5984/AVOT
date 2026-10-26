import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { photoProcessingSchema, type PhotoProcessing } from "@avot/shared";
import { db } from "../db";
import { log } from "../log";
import { keys, storage } from "../storage";
import { processBook, type BookResult } from "./book-image";

const DISPLAYABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/tiff"]);

export interface QualityReport {
  /** advisory hints only — never used to delete or approve a photo */
  lowResolution?: boolean;
  overexposed?: boolean;
  underexposed?: boolean;
  blurSuspect?: boolean;
  corrupt?: boolean;
  duplicateOfAssetId?: string;
  metrics: { megapixels?: number; meanLuma?: number; clippedHigh?: number; clippedLow?: number; sharpness?: number };
}

const MIN_MEGAPIXELS = 3;

/** The settings snapshot stored on a photo; null when absent or unreadable (the photo is then simply not processed). */
export function parseProcessing(raw: unknown): PhotoProcessing | null {
  const r = photoProcessingSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Identifies one version of the settings + manual edits, so stale background jobs can recognise themselves. */
export function processingFingerprint(p: PhotoProcessing): string {
  return createHash("sha1").update(JSON.stringify(p)).digest("hex").slice(0, 16);
}

export interface ProcessingResultInfo {
  stage: "preview" | "full";
  state: "DONE" | "NEEDS_REVIEW";
  confidence: number;
  warnings: string[];
  bounds: { x: number; y: number; w: number; h: number } | null;
  applied: BookResult["applied"];
  width: number;
  height: number;
  ms: number;
  fp: string;
  at: number;
}

export function resultInfo(book: BookResult, p: PhotoProcessing): ProcessingResultInfo {
  return {
    stage: book.stage,
    state: book.status,
    confidence: Number(book.confidence.toFixed(2)),
    warnings: book.warnings,
    bounds: book.bounds,
    applied: book.applied,
    width: book.width,
    height: book.height,
    ms: book.ms,
    fp: processingFingerprint(p),
    at: Date.now(),
  };
}

/** Thumbnail (WebP, keeps transparency) and preview (JPEG, flattened onto the chosen colour) of an image. */
export async function deriveImages(source: Buffer | sharp.Sharp, flatten: string): Promise<{ thumb: Buffer; preview: Buffer }> {
  const base = Buffer.isBuffer(source) ? sharp(source, { failOn: "error" }) : source;
  const [thumb, preview] = await Promise.all([
    base.clone().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
    base
      .clone()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .flatten({ background: flatten })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer(),
  ]);
  return { thumb, preview };
}

export const flattenColor = (p: PhotoProcessing | null) => (!p || p.settings.background === "transparent" ? "#ffffff" : p.settings.background);

/** Queues the full-resolution pass. Only QUEUED jobs are deduplicated: a RUNNING one may hold older settings. */
export async function enqueueFinalStage(organizationId: string, assetId: string): Promise<void> {
  const queued = await db.job.findFirst({
    where: { type: "PROCESS_FINAL", status: "QUEUED", payload: { path: ["assetId"], equals: assetId } },
    select: { id: true },
  });
  if (!queued) await db.job.create({ data: { organizationId, type: "PROCESS_FINAL", payload: { assetId } } });
}

async function analyse(image: sharp.Sharp): Promise<Omit<QualityReport, "duplicateOfAssetId" | "corrupt">> {
  const grey = image.clone().greyscale().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true });
  const { data, info } = await grey.clone().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let high = 0;
  let low = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    sum += v;
    if (v >= 250) high++;
    else if (v <= 5) low++;
  }
  const n = info.width * info.height;
  const meanLuma = sum / n;

  // variance of the Laplacian — a standard, cheap focus measure
  const lap = await grey
    .clone()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .raw()
    .toBuffer();
  let lsum = 0;
  let lsq = 0;
  for (let i = 0; i < lap.length; i++) {
    const v = lap[i]! - 128;
    lsum += v;
    lsq += v * v;
  }
  const lmean = lsum / lap.length;
  const sharpness = lsq / lap.length - lmean * lmean;

  return {
    overexposed: high / n > 0.08,
    underexposed: low / n > 0.25 || meanLuma < 35,
    blurSuspect: sharpness < 12,
    metrics: {
      meanLuma: Math.round(meanLuma),
      clippedHigh: Number((high / n).toFixed(4)),
      clippedLow: Number((low / n).toFixed(4)),
      sharpness: Number(sharpness.toFixed(1)),
    },
  };
}

/**
 * Builds thumbnail (480px WebP) and preview (2048px JPEG) derivatives from the
 * verified PRIMARY original, plus advisory quality hints. The original object
 * is only ever read.
 */
export async function processAssetDerivatives(assetId: string): Promise<void> {
  const asset = await db.photoAsset.findUnique({ where: { id: assetId }, include: { files: true } });
  if (!asset) return;
  const primary = asset.files.find((f) => f.role === "PRIMARY" && f.uploadStatus === "VERIFIED");
  if (!primary || !DISPLAYABLE.has(primary.mimeType)) {
    if (!asset.files.some((f) => f.role === "PRIMARY")) {
      await db.photoAsset.update({ where: { id: assetId }, data: { processingStatus: "UNSUPPORTED" } });
    }
    return;
  }

  const store = storage();
  try {
    const buffer = await store.getBuffer(primary.storageKey);
    const base = sharp(buffer, { failOn: "error" }).rotate();
    const meta = await sharp(buffer).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;

    const processing = parseProcessing(asset.processing);
    let book: BookResult | null = null;
    let bookError: string | null = null;
    if (processing) {
      try {
        book = await processBook(buffer, processing, "preview", `${asset.id}:${processingFingerprint(processing)}`);
      } catch (err) {
        // the original is untouched; fall back to plain derivatives and flag the failure
        bookError = err instanceof Error ? err.message.slice(0, 300) : "processing failed";
        log.warn("preview processing failed", { assetId, err });
      }
    }

    const [{ thumb, preview }, analysis] = await Promise.all([
      deriveImages(book ? book.data : base, flattenColor(processing)),
      analyse(base),
    ]);
    const thumbKey = keys.thumb(asset.organizationId, asset.id);
    const previewKey = keys.preview(asset.organizationId, asset.id);
    await store.putBuffer(thumbKey, thumb, "image/webp");
    await store.putBuffer(previewKey, preview, "image/jpeg");

    const megapixels = width && height ? (width * height) / 1e6 : undefined;
    const duplicate = await db.photoFile.findFirst({
      where: {
        sha256: primary.sha256,
        id: { not: primary.id },
        asset: { organizationId: asset.organizationId, deletedAt: null },
      },
      select: { assetId: true },
    });
    const quality: QualityReport = {
      ...analysis,
      lowResolution: megapixels !== undefined && megapixels < MIN_MEGAPIXELS,
      duplicateOfAssetId: duplicate?.assetId,
      metrics: { ...analysis.metrics, megapixels: megapixels ? Number(megapixels.toFixed(1)) : undefined },
    };

    await db.photoAsset.update({
      where: { id: asset.id },
      data: {
        thumbKey,
        previewKey,
        width: width ?? asset.width,
        height: height ?? asset.height,
        processingStatus: "DONE",
        quality: quality as object,
        ...(processing
          ? book
            ? { imageState: book.status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "PREVIEW_READY", processingResult: resultInfo(book, processing) as object }
            : { imageState: "FAILED", processingResult: { error: bookError, at: Date.now() } as object }
          : {}),
        exif: {
          ...((asset.exif as object | null) ?? {}),
          format: meta.format,
          density: meta.density,
          orientation: meta.orientation,
          space: meta.space,
          hasProfile: meta.hasProfile,
        },
      },
    });
    // the full-resolution pass runs in the background; the preview above is already usable
    if (book) await enqueueFinalStage(asset.organizationId, asset.id);
  } catch (err) {
    log.warn("derivative processing failed", { assetId, err });
    await db.photoAsset.update({
      where: { id: asset.id },
      data: { processingStatus: "FAILED", quality: { corrupt: true, metrics: {} } satisfies QualityReport as object },
    });
  }
}
