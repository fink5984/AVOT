import "server-only";
import { AppError } from "./errors";

/**
 * Fixed-window in-memory rate limiter. Adequate for the single web instance
 * this deployment runs; with several instances, each enforces its own window
 * (documented in docs/security.md).
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function bucket(key: string, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  return b;
}

function reject(resetAt: number): never {
  const seconds = Math.ceil((resetAt - Date.now()) / 1000);
  throw new AppError("RATE_LIMITED", `יותר מדי ניסיונות. נסו שוב בעוד ${seconds} שניות.`);
}

/** Counts every call (pairing, invite acceptance, …). */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const b = bucket(key, windowMs);
  b.count += 1;
  if (b.count > limit) reject(b.resetAt);
}

/** Login-style limiting: refuse once too many *failures* accumulated; successes cost nothing. */
export function assertFailureBudget(key: string, limit: number, windowMs: number) {
  const b = bucket(key, windowMs);
  if (b.count >= limit) reject(b.resetAt);
}

export function recordFailure(key: string, windowMs: number) {
  bucket(key, windowMs).count += 1;
}
