/*
 * Photography gate of AI analysis. An analysis reads the book's photos, so it may start only when the photography of the
 * book is finished. The photo count says nothing about that: the official photography status does (the same LotStatus
 * values the capture workflow uses - no status of its own).
 *
 *   NOT_STARTED / IN_PROGRESS / PENDING_REVIEW / NEEDS_RESHOOT → not allowed
 *   COMPLETED                                                  → allowed (when no upload / image processing is still running)
 *
 * PENDING_REVIEW is "photography done, waiting for somebody to confirm the series is complete": until it is confirmed
 * (COMPLETED) the series is not final. This file is shared by the server (the real enforcement) and the buttons (to
 * explain why they are disabled); it must stay free of server-only imports.
 */

export const PHOTO_GATE_MESSAGE = "לא ניתן לבצע ניתוח AI לפני השלמת צילום הספר.";

const REASON: Record<string, string> = {
  NOT_STARTED: "הספר טרם צולם",
  IN_PROGRESS: "הספר נמצא בצילום",
  PENDING_REVIEW: "הצילום ממתין לאישור השלמת סדרת התמונות",
  NEEDS_RESHOOT: "נדרש צילום חוזר של הספר",
};

/** null = photography is complete; otherwise the full sentence the UI / API shows. */
export function photoGateBlock(photoStatus: string | null | undefined): string | null {
  if (!photoStatus || photoStatus === "COMPLETED") return null;
  return `${PHOTO_GATE_MESSAGE} (${REASON[photoStatus] ?? "הצילום לא הושלם"})`;
}
