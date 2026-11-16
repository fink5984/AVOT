import "server-only";
import { db, type Tx } from "../db";
import { AppError } from "../errors";
import { PHOTO_GATE_MESSAGE, photoGateBlock } from "@/lib/photo-gate";

/*
 * The server side of the photography gate (rules and wording: src/lib/photo-gate.ts). Called
 *   1. when an analysis is requested (before anything is queued or charged),
 *   2. again inside the request's transaction, with the book row locked (photography re-opened between the check and the queue),
 *   3. when the worker takes the run, and
 *   4. right before the first model call, after the photos were prepared (photography re-opened while they were prepared).
 * A run that fails the gate is closed with the message and never sends a photo to a model.
 */

/** a capture session with this much recent activity counts as "the photographer is working on the book" */
const SESSION_ACTIVE_MS = 10 * 60 * 1000;

export interface PhotoReadiness {
  ready: boolean;
  /** the sentence to show (null when ready) */
  reason: string | null;
  code: "PHOTOGRAPHY_NOT_COMPLETE" | "CAPTURE_SESSION_ACTIVE" | "UPLOADS_PENDING" | "PROCESSING_PENDING" | null;
}

const ok: PhotoReadiness = { ready: true, reason: null, code: null };

export async function photoReadiness(itemId: string, tx: Tx | typeof db = db): Promise<PhotoReadiness> {
  const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { photoStatus: true } });
  if (!item) return { ready: false, reason: "הספר לא נמצא", code: "PHOTOGRAPHY_NOT_COMPLETE" };
  const status = photoGateBlock(item.photoStatus);
  if (status) return { ready: false, reason: status, code: "PHOTOGRAPHY_NOT_COMPLETE" };

  const [session, uploads, processing] = await Promise.all([
    tx.captureSession.count({ where: { inventoryItemId: itemId, status: "ACTIVE", lastActivityAt: { gt: new Date(Date.now() - SESSION_ACTIVE_MS) } } }),
    // the displayable original of a live photo that is not verified in storage yet (uploading, waiting, failed)
    tx.photoAsset.count({ where: { inventoryItemId: itemId, deletedAt: null, files: { some: { role: "PRIMARY", uploadStatus: { not: "VERIFIED" } } } } }),
    // green-screen processing (rotation / background / crop) still queued or only at its fast preview
    tx.photoAsset.count({ where: { inventoryItemId: itemId, deletedAt: null, imageState: { in: ["QUEUED", "PREVIEW_READY"] } } }),
  ]);
  if (session > 0) return { ready: false, reason: `${PHOTO_GATE_MESSAGE} (הספר נמצא כעת בצילום פעיל)`, code: "CAPTURE_SESSION_ACTIVE" };
  if (uploads > 0) return { ready: false, reason: `${PHOTO_GATE_MESSAGE} (${uploads} תמונות עדיין לא הועלו ואומתו)`, code: "UPLOADS_PENDING" };
  if (processing > 0) return { ready: false, reason: `${PHOTO_GATE_MESSAGE} (עיבוד ${processing} תמונות עדיין לא הסתיים)`, code: "PROCESSING_PENDING" };
  return ok;
}

/** Throws the clear 409 the API returns (and the worker records on the run) when the photos are not final. */
export async function assertPhotosReady(itemId: string, tx: Tx | typeof db = db) {
  const r = await photoReadiness(itemId, tx);
  if (!r.ready) throw new AppError("CONFLICT", r.reason!, { code: r.code ?? "PHOTOGRAPHY_NOT_COMPLETE" });
}
