"use client";

import type { ScanOpInput, ScanResponse } from "@avot/shared";

/**
 * Durable scan log of the handheld (IndexedDB, separate database from the
 * capture outbox). Every scan is written here BEFORE it is sent, so a scan is
 * never lost to a dropped connection or a closed tab. Status is only ever
 * advanced by a server answer:
 *   pending  — waiting to sync (never shown as saved)
 *   synced   — the server applied it / recorded it (OK, NOOP)
 *   error    — the server refused it (unknown code, not allowed …)
 *   conflict — synced late with contradicting data; a manager must decide
 * The opId generated at scan time makes re-sending safe (server idempotency).
 */

export type ScanStatus = "pending" | "synced" | "error" | "conflict";

export interface QueuedScan {
  opId: string;
  userId: string;
  op: ScanOpInput;
  status: ScanStatus;
  response?: ScanResponse;
  /** sent while the device was offline (or the request failed) — synced later */
  deferred: boolean;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = "avot-scanner";
const STORE = "scans";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("הדפדפן אינו תומך באחסון מקומי"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: "opId" });
      s.createIndex("byUser", ["userId", "createdAt"]);
      s.createIndex("byStatus", "status");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    // "strict" durability: the scan is on disk before we report it as recorded locally
    const t = db.transaction(STORE, mode, { durability: "strict" } as IDBTransactionOptions);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const scanQueue = {
  put: (s: QueuedScan) => tx("readwrite", (st) => st.put(s)).then(() => s),
  get: (opId: string) => tx<QueuedScan>("readonly", (st) => st.get(opId)),
  async list(userId: string, limit = 60): Promise<QueuedScan[]> {
    const all = (await tx<QueuedScan[]>("readonly", (st) => st.index("byUser").getAll(IDBKeyRange.bound([userId, 0], [userId, Infinity])))) ?? [];
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
  async pending(userId: string): Promise<QueuedScan[]> {
    const all = (await tx<QueuedScan[]>("readonly", (st) => st.index("byStatus").getAll("pending"))) ?? [];
    return all.filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  },
  /** keep the log bounded: synced entries older than a week are dropped; pending / error / conflict are kept */
  async prune(maxAgeMs = 7 * 24 * 3600 * 1000) {
    const all = (await tx<QueuedScan[]>("readonly", (st) => st.getAll())) ?? [];
    const old = all.filter((s) => s.status === "synced" && Date.now() - s.updatedAt > maxAgeMs);
    for (const s of old) await tx("readwrite", (st) => st.delete(s.opId));
  },
};
