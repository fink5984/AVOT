"use client";

import type { RegisterCaptureResponse } from "@avot/shared";
import { outbox, type OutboxEntry, type OutboxStage } from "./outbox";

export interface UploadEvent {
  captureId: string;
  stage: OutboxStage | "VERIFIED";
  assetId?: string;
  sequence?: number;
  error?: string;
  attempts?: number;
}

type Listener = (e: UploadEvent) => void;

const MAX_BACKOFF_MS = 60_000;
const ATTENTION_AFTER = 6;
const ATTENTION_RETRY_MS = 5 * 60_000;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, credentials: "same-origin" });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    throw new HttpError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code);
  }
  return data as T;
}

/**
 * Sequential, resumable uploader for the browser outbox. One instance per
 * browser profile (Web Locks), so several open tabs never upload the same
 * capture concurrently. Every step is idempotent on the server, so a retry
 * after a lost response, a crash or a reload is always safe.
 */
class Uploader {
  private listeners = new Set<Listener>();
  private userId: string | null = null;
  private running = false;
  private wake: (() => void) | null = null;
  private stopped = false;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: UploadEvent) {
    for (const fn of this.listeners) fn(e);
  }

  start(userId: string) {
    this.userId = userId;
    this.stopped = false;
    if (this.running) return this.kick();
    this.running = true;
    const run = () => this.loop().finally(() => (this.running = false));
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      void navigator.locks.request("avot-outbox-uploader", run);
    } else {
      void run();
    }
    if (!this.onlineHooked) {
      this.onlineHooked = true;
      window.addEventListener("online", () => this.kick());
    }
  }

  private onlineHooked = false;

  stop() {
    this.stopped = true;
    this.kick();
  }

  /** Wake the loop now (new capture, connectivity restored, manual retry). */
  kick() {
    this.wake?.();
  }

  async retryNow(captureId: string) {
    await outbox.update(captureId, { nextAttemptAt: 0, stage: "QUEUED" });
    this.kick();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async loop() {
    while (!this.stopped) {
      let entries: OutboxEntry[] = [];
      try {
        entries = this.userId ? await outbox.all(this.userId) : [];
      } catch {
        await this.sleep(5000);
        continue;
      }
      const now = Date.now();
      const due = entries.find((e) => e.nextAttemptAt <= now);
      if (!due) {
        const next = entries.reduce((m, e) => Math.min(m, e.nextAttemptAt), Infinity);
        await this.sleep(Number.isFinite(next) ? Math.max(250, Math.min(next - now, 30_000)) : 30_000);
        continue;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await this.markRetry(due, "אין חיבור לאינטרנט — הקובץ שמור מקומית וימתין");
        await this.sleep(3000);
        continue;
      }
      await this.uploadOne(due);
    }
  }

  private async markRetry(entry: OutboxEntry, error: string, permanent = false) {
    const attempts = entry.attempts + 1;
    const attention = permanent || attempts >= ATTENTION_AFTER;
    const delay = attention ? ATTENTION_RETRY_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
    const stage: OutboxStage = attention ? "NEEDS_ATTENTION" : "QUEUED";
    await outbox.update(entry.captureId, { attempts, stage, lastError: error, nextAttemptAt: Date.now() + delay });
    this.emit({ captureId: entry.captureId, stage, error, attempts });
  }

  private async uploadOne(entry: OutboxEntry) {
    this.emit({ captureId: entry.captureId, stage: "UPLOADING" });
    await outbox.update(entry.captureId, { stage: "UPLOADING" });
    try {
      const reg = await call<RegisterCaptureResponse>("/api/captures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          captureId: entry.captureId,
          lotId: entry.lotId,
          category: entry.category,
          source: entry.source,
          capturedAt: entry.capturedAt,
          sessionId: entry.sessionId,
          cameraName: entry.cameraName,
          exif: entry.exif,
          processing: entry.processing,
          files: entry.files.map((f) => ({
            role: f.role,
            originalFilename: f.filename,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
            sha256: f.sha256,
            width: f.width,
            height: f.height,
          })),
        }),
      });
      await outbox.update(entry.captureId, { assetId: reg.assetId, sequence: reg.sequence });

      for (const remote of reg.files) {
        if (remote.uploadStatus === "VERIFIED") continue;
        const local = entry.files.find((f) => f.role === remote.role);
        if (!local) throw new HttpError("קובץ מקומי חסר לתפקיד " + remote.role, 0);
        await call(remote.uploadUrl, {
          method: "PUT",
          headers: { "content-type": local.mimeType },
          body: local.blob,
        });
      }
      // only now — every original verified by the server — the local copy may go
      await outbox.delete(entry.captureId);
      this.emit({ captureId: entry.captureId, stage: "VERIFIED", assetId: reg.assetId, sequence: reg.sequence });
    } catch (err) {
      const e = err as HttpError;
      if (e.status === 401) {
        await this.markRetry(entry, "פג תוקף ההתחברות — התחברו מחדש כדי להשלים את ההעלאה");
      } else if (e.status === 409 || e.status === 404 || e.status === 400) {
        // conflicting or invalid metadata: keep the file, stop hammering, ask a human
        await this.markRetry(entry, e.message, true);
      } else {
        await this.markRetry(entry, e.message || "ההעלאה נכשלה");
      }
    }
  }
}

export const uploader = new Uploader();

export async function outboxCounts(userId: string) {
  const all = await outbox.all(userId);
  return {
    pending: all.length,
    attention: all.filter((e) => e.stage === "NEEDS_ATTENTION").length,
    bytes: all.reduce((s, e) => s + e.files.reduce((x, f) => x + f.sizeBytes, 0), 0),
  };
}
