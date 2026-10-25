import "server-only";
import sharp from "sharp";
import { db } from "../db";
import { log } from "../log";
import { keys, storage } from "../storage";

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

    const [thumb, preview, analysis] = await Promise.all([
      base.clone().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
      base.clone().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
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
  } catch (err) {
    log.warn("derivative processing failed", { assetId, err });
    await db.photoAsset.update({
      where: { id: asset.id },
      data: { processingStatus: "FAILED", quality: { corrupt: true, metrics: {} } satisfies QualityReport as object },
    });
  }
}
