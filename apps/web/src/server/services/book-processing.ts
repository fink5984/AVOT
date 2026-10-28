import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { DEFAULT_PROCESSING, manualEditsSchema, photoProcessingSchema, processingSettingsSchema, type PhotoProcessing, type Rotation } from "@avot/shared";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import type { UserPrincipal } from "../auth/principal";
import { keys, storage } from "../storage";
import { editSourceJpeg, processBook } from "./book-image";
import { defaultProcessing } from "./camera-profiles";
import {
  deriveImages,
  flattenColor,
  parseProcessing,
  processAssetDerivatives,
  processingFingerprint,
  resultInfo,
  type ProcessingResultInfo,
} from "./derivatives";
import { assetSelect } from "./assets";

/*
 * Background (full-resolution) stage and manual correction of processed photos.
 * The PRIMARY original is only ever read; every result is a new object.
 */

async function loadWithOriginal(assetId: string) {
  const asset = await db.photoAsset.findUnique({ where: { id: assetId }, include: { files: true } });
  if (!asset) return null;
  const primary = asset.files.find((f) => f.role === "PRIMARY" && f.uploadStatus === "VERIFIED");
  return primary ? { asset, primary } : null;
}

/** PROCESS_FINAL job: full-resolution rotation, background removal and crop. Idempotent and safe to retry. */
export async function finalizeProcessedAsset(assetId: string): Promise<void> {
  const loaded = await loadWithOriginal(assetId);
  if (!loaded) return;
  const { asset, primary } = loaded;
  const processing = parseProcessing(asset.processing);
  if (!processing || asset.deletedAt) return;
  const fp = processingFingerprint(processing);
  const prev = asset.processingResult as Partial<ProcessingResultInfo> | null;
  if ((asset.imageState === "DONE" || asset.imageState === "NEEDS_REVIEW") && prev?.stage === "full" && prev.fp === fp && asset.processedKey) return;

  const store = storage();
  const buffer = await store.getBuffer(primary.storageKey);
  const book = await processBook(buffer, processing, "full", `${asset.id}:${fp}`);

  // settings changed while we worked (manual correction) → a newer job is queued, drop this result
  const fresh = await db.photoAsset.findUnique({ where: { id: assetId }, select: { processing: true, processedKey: true, deletedAt: true } });
  const current = fresh ? parseProcessing(fresh.processing) : null;
  if (!fresh || !current || processingFingerprint(current) !== fp) return;

  const key = keys.processed(asset.organizationId, asset.id, book.ext);
  await store.putBuffer(key, book.data, book.mime);
  if (fresh.processedKey && fresh.processedKey !== key) await store.delete(fresh.processedKey).catch(() => undefined);
  const { thumb, preview } = await deriveImages(book.data, flattenColor(processing));
  const thumbKey = keys.thumb(asset.organizationId, asset.id);
  const previewKey = keys.preview(asset.organizationId, asset.id);
  await store.putBuffer(thumbKey, thumb, "image/webp");
  await store.putBuffer(previewKey, preview, "image/jpeg");

  await db.photoAsset.update({
    where: { id: assetId },
    data: {
      thumbKey,
      previewKey,
      processedKey: key,
      processedMime: book.mime,
      processedWidth: book.width,
      processedHeight: book.height,
      imageState: book.status,
      processingResult: resultInfo(book, processing) as object,
    },
  });
}

/** Called when the background job exhausted its retries: the original and the preview stay, the flag tells a human. */
export async function markFinalFailed(assetId: string, message: string): Promise<void> {
  await db.photoAsset.updateMany({
    where: { id: assetId, imageState: { in: ["QUEUED", "PREVIEW_READY"] } },
    data: { imageState: "FAILED", processingResult: { error: message.slice(0, 300), at: Date.now() } as object },
  });
}

export const reprocessSchema = z.object({
  /** partial overrides of the stored settings (rotation, sensitivity, margin, background …) */
  settings: processingSettingsSchema.partial().optional(),
  /** manual crop / brush strokes; `crop: null` clears a manual crop */
  edits: manualEditsSchema.optional(),
  /** back to the untouched original: processed file removed, plain derivatives rebuilt */
  restore: z.boolean().optional(),
});
export type ReprocessInput = z.infer<typeof reprocessSchema>;

/** Manual correction of one photo. The preview is rebuilt before returning; the full-resolution file follows in the background. */
export async function reprocessAsset(user: UserPrincipal, assetId: string, input: ReprocessInput) {
  const loaded = await loadWithOriginal(assetId);
  if (!loaded || loaded.asset.organizationId !== user.organizationId || loaded.asset.deletedAt) throw notFound("התמונה");
  const { asset } = loaded;
  const store = storage();

  if (input.restore) {
    if (asset.processedKey) await store.delete(asset.processedKey).catch(() => undefined);
    await db.photoAsset.update({
      where: { id: assetId },
      data: {
        processing: Prisma.DbNull,
        processingResult: Prisma.DbNull,
        imageState: "NONE",
        processedKey: null,
        processedMime: null,
        processedWidth: null,
        processedHeight: null,
      },
    });
    await processAssetDerivatives(assetId);
    await audit(user, { action: "photo.processing_restored", entityType: "asset", entityId: assetId, lotId: asset.lotId, inventoryItemId: asset.inventoryItemId });
    return db.photoAsset.findUniqueOrThrow({ where: { id: assetId }, select: assetSelect });
  }

  const current = parseProcessing(asset.processing);
  const base = current?.settings ?? (await defaultProcessing(user.organizationId)) ?? DEFAULT_PROCESSING;
  const edits = input.edits === undefined ? current?.edits : { ...input.edits, confirmed: true };
  const next: PhotoProcessing = photoProcessingSchema.parse({ settings: { ...base, ...input.settings }, edits });

  await db.photoAsset.update({ where: { id: assetId }, data: { processing: next as object, imageState: "QUEUED" } });
  await processAssetDerivatives(assetId); // preview stage + queues the full-resolution job
  await audit(user, {
    action: "photo.reprocessed",
    entityType: "asset",
    entityId: assetId,
    lotId: asset.lotId,
    inventoryItemId: asset.inventoryItemId,
    data: { settings: input.settings ?? {}, strokes: input.edits?.strokes?.length ?? 0, crop: !!input.edits?.crop },
  });
  return db.photoAsset.findUniqueOrThrow({ where: { id: assetId }, select: assetSelect });
}

/** Rotated working copy of the original for the correction editor (same orientation the server will process). */
export async function editSource(orgId: string, assetId: string, rotation?: Rotation, longEdge?: number): Promise<Buffer> {
  const loaded = await loadWithOriginal(assetId);
  if (!loaded || loaded.asset.organizationId !== orgId) throw notFound("התמונה");
  const processing = parseProcessing(loaded.asset.processing);
  const rot = rotation ?? processing?.settings.rotation ?? (await defaultProcessing(orgId))?.rotation ?? DEFAULT_PROCESSING.rotation;
  try {
    return await editSourceJpeg(await storage().getBuffer(loaded.primary.storageKey), rot, longEdge);
  } catch (err) {
    log.warn("edit source failed", { assetId, err });
    throw new AppError("INTERNAL", "לא ניתן לטעון את התמונה לעריכה");
  }
}
