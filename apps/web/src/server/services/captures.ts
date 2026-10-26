import "server-only";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { RegisterCaptureInput, RegisterCaptureResponse, UploadFileResponse } from "@avot/shared";
import { db } from "../db";
import { AppError, forbidden, notFound } from "../errors";
import { log } from "../log";
import { audit } from "../audit";
import { can } from "../auth/permissions";
import type { Principal } from "../auth/principal";
import { keys, storage } from "../storage";
import { verifyControlTokenForAttribution } from "./control-token";
import { lockItem, recountItem } from "./lot-counters";
import { resolveItemTarget } from "./inventory";
import { changeStatus } from "./item-status";
import { processAssetDerivatives } from "./derivatives";
import { defaultProcessing } from "./camera-profiles";
import type { PhotoProcessing } from "@avot/shared";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/tiff": "tif",
  "image/x-canon-cr3": "cr3",
  "image/x-canon-cr2": "cr2",
  "image/x-adobe-dng": "dng",
};

function extensionFor(mime: string, filename: string): string {
  const fromName = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (/^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[mime] ?? "bin";
}

async function resolveCreator(principal: Principal, input: RegisterCaptureInput): Promise<string | null> {
  if (principal.kind === "user") {
    if (!can(principal.role, "photo.capture")) throw forbidden();
    return principal.userId;
  }
  if (!input.controlToken) return null;
  const payload = await verifyControlTokenForAttribution(input.controlToken, principal.deviceId);
  if (!payload || payload.orgId !== principal.organizationId) return null;
  const user = await db.user.findFirst({
    where: { id: payload.userId, organizationId: principal.organizationId },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Processing settings are frozen with the shot (what the profile said when the shutter was
 * pressed). Callers that send none get the organization's default profile; imports and
 * organizations without any profile are never processed.
 */
async function resolveProcessing(orgId: string, input: RegisterCaptureInput): Promise<PhotoProcessing | null> {
  if (input.source === "IMPORT") return null;
  const settings = input.processing ?? (await defaultProcessing(orgId));
  return settings ? { settings } : null;
}

function toResponse(asset: {
  id: string;
  captureId: string;
  sequence: number;
  files: { id: string; role: "PRIMARY" | "RAW"; uploadStatus: "PENDING" | "UPLOADING" | "VERIFIED" | "FAILED" }[];
}): RegisterCaptureResponse {
  return {
    assetId: asset.id,
    captureId: asset.captureId,
    sequence: asset.sequence,
    files: asset.files.map((f) => ({
      fileId: f.id,
      role: f.role,
      uploadStatus: f.uploadStatus,
      uploadUrl: `/api/files/${f.id}/content`,
    })),
  };
}

/**
 * Step 1 — register a shot. Idempotent on (organization, captureId): a retry
 * after a lost response returns the same asset. The book/category frozen at the
 * moment the shutter was pressed travel inside the request, so switching
 * category while an upload is in flight cannot re-associate the shot.
 */
export async function registerCapture(principal: Principal, input: RegisterCaptureInput): Promise<RegisterCaptureResponse> {
  const orgId = principal.organizationId;
  const createdById = await resolveCreator(principal, input);

  const roles = new Set(input.files.map((f) => f.role));
  if (roles.size !== input.files.length) throw new AppError("VALIDATION", "כל תפקיד קובץ יכול להופיע פעם אחת בלבד");

  // Target: an inventory item, or a catalog lot (resolved to its item). The
  // agent sends one opaque id in `lotId` — it may be either (API v1 compatible).
  const target = await resolveItemTarget(orgId, input.inventoryItemId ?? input.lotId!);
  if (!target) throw notFound("הספר");
  if (input.inventoryItemId && input.lotId && input.lotId !== input.inventoryItemId) {
    const lotTarget = await resolveItemTarget(orgId, input.lotId);
    if (!lotTarget || lotTarget.itemId !== target.itemId) throw new AppError("VALIDATION", "הפריט אינו שייך לספר שנבחר");
    target.lot = lotTarget.lot;
  }
  const itemId = target.itemId;

  const existing = await db.photoAsset.findUnique({
    where: { organizationId_captureId: { organizationId: orgId, captureId: input.captureId } },
    include: { files: true },
  });
  if (existing) {
    if (existing.inventoryItemId !== itemId || existing.category !== input.category) {
      throw new AppError("CONFLICT", "מזהה הצילום כבר שויך לספר או לקטגוריה אחרים");
    }
    return toResponse(existing);
  }

  const primary = input.files.find((f) => f.role === "PRIMARY");
  const processing = await resolveProcessing(orgId, input);

  try {
    return await db.$transaction(async (tx) => {
      await lockItem(tx, itemId);
      const [seqAgg, sortAgg] = await Promise.all([
        tx.photoAsset.aggregate({ where: { inventoryItemId: itemId }, _max: { sequence: true } }),
        tx.photoAsset.aggregate({ where: { inventoryItemId: itemId, category: input.category }, _max: { sortOrder: true } }),
      ]);
      const asset = await tx.photoAsset.create({
        data: {
          organizationId: orgId,
          inventoryItemId: itemId,
          catalogId: target.lot?.catalogId ?? null,
          lotId: target.lot?.id ?? null,
          category: input.category,
          captureId: input.captureId,
          captureSessionId: input.sessionId ?? null,
          source: input.source,
          cameraName: input.cameraName ?? null,
          sequence: (seqAgg._max.sequence ?? 0) + 1,
          sortOrder: (sortAgg._max.sortOrder ?? 0) + 1,
          capturedAt: new Date(input.capturedAt),
          width: primary?.width ?? null,
          height: primary?.height ?? null,
          exif: (input.exif ?? undefined) as object | undefined,
          createdById,
          ...(processing ? { processing: processing as object, imageState: "QUEUED" as const } : {}),
        },
      });
      const files = [];
      for (const f of input.files) {
        const ext = extensionFor(f.mimeType, f.originalFilename);
        files.push(
          await tx.photoFile.create({
            data: {
              assetId: asset.id,
              role: f.role,
              originalFilename: f.originalFilename,
              mimeType: f.mimeType,
              extension: ext,
              sizeBytes: BigInt(f.sizeBytes),
              sha256: f.sha256,
              storageKey: keys.original(orgId, asset.id, f.role, ext),
            },
          }),
        );
      }
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { photoStatus: true } });
      if (item.photoStatus === "NOT_STARTED") await changeStatus(tx, principal, itemId, "PHOTO", "IN_PROGRESS", { refType: "capture", refId: asset.id });
      if (input.sessionId) {
        await tx.captureSession.updateMany({
          where: { id: input.sessionId, organizationId: orgId },
          data: { shotCount: { increment: 1 }, lastActivityAt: new Date() },
        });
      }
      await recountItem(tx, itemId);
      await audit(
        principal,
        {
          action: "photo.captured",
          entityType: "asset",
          entityId: asset.id,
          lotId: target.lot?.id ?? null,
          inventoryItemId: itemId,
          data: { category: input.category, source: input.source, sequence: asset.sequence, files: input.files.length },
        },
        tx,
      );
      return toResponse({ ...asset, files });
    });
  } catch (err) {
    // a concurrent identical register won the race — return its result
    if ((err as { code?: string }).code === "P2002") {
      const again = await db.photoAsset.findUnique({
        where: { organizationId_captureId: { organizationId: orgId, captureId: input.captureId } },
        include: { files: true },
      });
      if (again) return toResponse(again);
    }
    throw err;
  }
}

/** Fails the stream as soon as more bytes arrive than were declared. */
function sizeGuard(limit: number) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) cb(new AppError("PAYLOAD_TOO_LARGE", "הקובץ גדול מהגודל שהוצהר"));
      else cb(null, chunk);
    },
  });
}

/**
 * Step 2 — stream the original bytes into object storage, hashing on the way.
 * Only when the stored bytes' SHA-256 and size equal what the uploader declared
 * is the file marked VERIFIED. Repeating a verified upload is a no-op.
 */
export async function uploadFileContent(principal: Principal, fileId: string, body: ReadableStream<Uint8Array> | null): Promise<UploadFileResponse> {
  const file = await db.photoFile.findUnique({ where: { id: fileId }, include: { asset: true } });
  if (!file || file.asset.organizationId !== principal.organizationId) throw notFound("הקובץ");
  if (principal.kind === "user" && !can(principal.role, "photo.capture")) throw forbidden();

  if (file.uploadStatus === "VERIFIED") {
    return { fileId: file.id, assetId: file.assetId, uploadStatus: "VERIFIED", sha256: file.sha256, sizeBytes: Number(file.sizeBytes) };
  }
  if (!body) throw new AppError("VALIDATION", "גוף הבקשה ריק");

  await db.photoFile.update({ where: { id: file.id }, data: { uploadStatus: "UPLOADING", uploadAttempts: { increment: 1 } } });

  const store = storage();
  let result;
  try {
    const nodeStream = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>).pipe(sizeGuard(Number(file.sizeBytes)));
    result = await store.putStream(file.storageKey, nodeStream, file.mimeType);
  } catch (err) {
    await db.photoFile.update({
      where: { id: file.id },
      data: { uploadStatus: "FAILED", lastError: err instanceof Error ? err.message.slice(0, 500) : "upload failed" },
    });
    log.warn("upload stream failed", { fileId, err });
    if (err instanceof AppError) throw err;
    throw new AppError("INTERNAL", "ההעלאה נקטעה. הקובץ יישלח שוב אוטומטית.");
  }

  if (result.sha256 !== file.sha256 || result.sizeBytes !== Number(file.sizeBytes)) {
    await store.delete(file.storageKey).catch(() => undefined);
    await db.photoFile.update({
      where: { id: file.id },
      data: {
        uploadStatus: "FAILED",
        lastError: `checksum mismatch: declared ${file.sha256}/${file.sizeBytes}, got ${result.sha256}/${result.sizeBytes}`,
      },
    });
    log.warn("checksum mismatch", { fileId, declared: file.sha256, actual: result.sha256 });
    throw new AppError("CHECKSUM_MISMATCH", "בדיקת השלמות נכשלה — הקובץ שהתקבל שונה מהמקור. הקובץ יישלח שוב.");
  }

  await db.photoFile.update({
    where: { id: file.id },
    data: { uploadStatus: "VERIFIED", verifiedAt: new Date(), lastError: null },
  });

  const pending = await db.photoFile.count({ where: { assetId: file.assetId, uploadStatus: { not: "VERIFIED" } } });
  if (pending === 0) {
    // derivatives are best-effort here; the job worker retries anything left PENDING.
    // The green-screen preview takes a second or two: it runs beside the response so a burst of
    // uploads is not slowed down (the UI shows "processing" until it lands; a lost run is re-queued by maintenance).
    const run = () => processAssetDerivatives(file.assetId).catch((err) => log.warn("derivatives failed inline", { assetId: file.assetId, err }));
    if (file.asset.processing) void run();
    else await run();
  }

  return { fileId: file.id, assetId: file.assetId, uploadStatus: "VERIFIED", sha256: result.sha256, sizeBytes: result.sizeBytes };
}

/** Lets an uploader reconcile: which files of a capture does the server already hold? */
export async function captureStatus(principal: Principal, captureId: string) {
  const asset = await db.photoAsset.findUnique({
    where: { organizationId_captureId: { organizationId: principal.organizationId, captureId } },
    include: { files: true },
  });
  return asset ? toResponse(asset) : null;
}
