"use client";

import type { CaptureSource, FileRole, PhotoCategory } from "@avot/shared";

/**
 * Durable browser-side outbox for captures made in the browser (webcam,
 * simulator, folder import). A capture counts as "saved locally" only after
 * the IndexedDB transaction that holds its original bytes has *committed*.
 * Entries survive tab close, browser restart and power loss (IndexedDB is
 * persisted to disk; we also request persistent storage so the browser does
 * not evict it under pressure). An entry is deleted only after the server
 * verified the SHA-256 of every original.
 */

export type OutboxStage = "SAVED_LOCAL" | "QUEUED" | "UPLOADING" | "NEEDS_ATTENTION";

export interface OutboxFile {
  role: FileRole;
  blob: Blob;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  width?: number;
  height?: number;
  verified?: boolean;
}

export interface OutboxEntry {
  captureId: string;
  userId: string;
  lotId: string;
  catalogId: string;
  category: PhotoCategory;
  lotLabel: string;
  source: CaptureSource;
  cameraName?: string;
  sessionId?: string;
  capturedAt: string;
  exif?: Record<string, unknown>;
  files: OutboxFile[];
  stage: OutboxStage;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  assetId?: string;
  sequence?: number;
  createdAt: number;
}

const DB_NAME = "avot-studio";
const STORE = "outbox";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("הדפדפן אינו תומך באחסון מקומי (IndexedDB) — לא ניתן לצלם בבטחה"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "captureId" });
      store.createIndex("byUser", "userId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("פתיחת האחסון המקומי נכשלה"));
    req.onblocked = () => reject(new Error("האחסון המקומי חסום על ידי לשונית אחרת — סגרו לשוניות ישנות"));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        // "strict" durability: resolve only after the data is flushed to disk
        const t = db.transaction(STORE, mode, { durability: "strict" } as IDBTransactionOptions);
        let result: T | undefined;
        const req = run(t.objectStore(STORE));
        if (req) req.onsuccess = () => (result = req.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error ?? new Error("שגיאת אחסון מקומי"));
        t.onabort = () => reject(t.error ?? new Error("פעולת האחסון המקומי בוטלה (ייתכן שהדיסק מלא)"));
      }),
  );
}

export const outbox = {
  /** Resolves only once the entry (including blobs) is committed to disk. */
  put: (entry: OutboxEntry) => tx("readwrite", (s) => s.put(entry)).then(() => undefined),
  get: (captureId: string) => tx<OutboxEntry>("readonly", (s) => s.get(captureId)),
  delete: (captureId: string) => tx("readwrite", (s) => s.delete(captureId)).then(() => undefined),
  all: async (userId?: string): Promise<OutboxEntry[]> => {
    const rows = ((await tx<OutboxEntry[]>("readonly", (s) => (userId ? s.index("byUser").getAll(userId) : s.getAll()))) ?? []) as OutboxEntry[];
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  update: async (captureId: string, patch: Partial<OutboxEntry>) => {
    const current = await outbox.get(captureId);
    if (!current) return;
    await outbox.put({ ...current, ...patch });
  },
};

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export interface StorageHealth {
  freeBytes: number | null;
  level: "ok" | "low" | "critical";
}

const LOW = 500 * 1024 * 1024;
const CRITICAL = 80 * 1024 * 1024;

/** Browser storage headroom. "critical" blocks capture — a shot that cannot be stored must not be taken. */
export async function storageHealth(): Promise<StorageHealth> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return { freeBytes: null, level: "ok" };
    const free = est.quota - (est.usage ?? 0);
    return { freeBytes: free, level: free < CRITICAL ? "critical" : free < LOW ? "low" : "ok" };
  } catch {
    return { freeBytes: null, level: "ok" };
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("חישוב חתימת SHA-256 דורש חיבור מאובטח (HTTPS או localhost)");
  }
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
