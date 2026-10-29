/**
 * One place that decides which picture a photo has and what its download buttons do, shared by the gallery tile, the viewer,
 * the capture studio and the ZIP export — so a "download" can never quietly hand out the green original as if it were the
 * processed image.
 */

export interface VersionedAsset {
  id: string;
  processedUrl: string | null;
  processed: { state: string; hasFile: boolean; mime: string | null } | null;
  files?: { role: string; uploadStatus: string }[];
}

/** states in which the full-resolution processed file on the server is the current, finished result */
export const PROCESSED_FINAL_STATES = ["DONE", "NEEDS_REVIEW"] as const;

export const PROCESSED_NOT_READY = "התמונה המעובדת עדיין אינה מוכנה להורדה.";

/** The processed file is the final one: it exists and the photo is not being (re)processed or failed. */
export function processedReady(a: Pick<VersionedAsset, "processed">): boolean {
  const p = a.processed;
  return !!p && p.hasFile && (PROCESSED_FINAL_STATES as readonly string[]).includes(p.state);
}

/** A processing pipeline is involved but has no final file: queued, preview only, failed. */
export function processedPending(a: Pick<VersionedAsset, "processed">): boolean {
  return !!a.processed && !processedReady(a);
}

export const hasRaw = (a: Pick<VersionedAsset, "files">): boolean => !!a.files?.some((f) => f.role === "RAW" && f.uploadStatus === "VERIFIED");

const dl = (path: string, v: string) => `${path}${path.includes("?") ? "&" : "?"}download=1&v=${encodeURIComponent(v)}`;

/** cache-buster that changes whenever the processed file is replaced (the DTO url already carries it) */
function versionOf(a: VersionedAsset): string {
  const m = /[?&]v=([^&]*)/.exec(a.processedUrl ?? "");
  return m?.[1] ?? "0";
}

export interface DownloadOptions {
  /** the plain download button: processed when ready, the original when the photo was never processed, nothing while it is pending */
  primary: { href: string; kind: "processed" | "original" } | null;
  processed: { href: string } | null;
  original: { href: string };
  raw: { href: string } | null;
  /** why `processed` is missing, for a message (null when there is nothing to explain) */
  processedMessage: string | null;
}

export function downloadOptions(a: VersionedAsset): DownloadOptions {
  const original = { href: dl(`/api/assets/${a.id}/original`, versionOf(a)) };
  const processed = processedReady(a) ? { href: dl(`/api/assets/${a.id}/processed`, versionOf(a)) } : null;
  const raw = hasRaw(a) ? { href: dl(`/api/assets/${a.id}/original?role=RAW`, "raw") } : null;
  return {
    primary: processed ? { href: processed.href, kind: "processed" } : a.processed ? null : { href: original.href, kind: "original" },
    processed,
    original,
    raw,
    processedMessage: processed || !a.processed ? null : PROCESSED_NOT_READY,
  };
}

/** Starts a browser download without leaving the page (no new tab, no navigation). */
export function startDownload(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
