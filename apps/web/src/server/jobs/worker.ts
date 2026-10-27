import "server-only";
import type { Job } from "@prisma/client";
import { db } from "../db";
import { log } from "../log";
import { storage } from "../storage";
import { runExportJob } from "../services/exports";
import { processAssetDerivatives, enqueueFinalStage } from "../services/derivatives";
import { finalizeProcessedAsset, markFinalFailed } from "../services/book-processing";
import { purgeExpiredTrash } from "../services/assets";
import { resumeStalledDeletions, runDeleteCatalogsJob, runDeleteItemsJob } from "../services/deletion";

const POLL_MS = 2000;
const STALE_LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAINTENANCE_MS = 10 * 60 * 1000;

let started = false;
let busy = false;

async function claimNext(): Promise<Job | null> {
  const rows = await db.$queryRaw<Job[]>`
    UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'QUEUED' AND "runAfter" <= now()
      ORDER BY "createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

async function runJob(job: Job) {
  try {
    if (job.type === "EXPORT_ZIP") await runExportJob(job);
    else if (job.type === "PROCESS_ASSET") await processAssetDerivatives((job.payload as { assetId: string }).assetId);
    else if (job.type === "PROCESS_FINAL") await finalizeProcessedAsset((job.payload as { assetId: string }).assetId);
    else if (job.type === "DELETE_ITEMS") await runDeleteItemsJob(job);
    else if (job.type === "DELETE_CATALOGS") await runDeleteCatalogsJob(job);
    else if (job.type === "PURGE_TRASH") {
      const org = await db.organization.findUnique({ where: { id: job.organizationId } });
      if (org) await purgeExpiredTrash(org.id, org.trashRetentionDays);
    }
    await db.job.update({ where: { id: job.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), error: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < (job.type === "DELETE_ITEMS" || job.type === "DELETE_CATALOGS" ? 6 : MAX_ATTEMPTS);
    log.error("job failed", { jobId: job.id, type: job.type, attempt: job.attempts, retry, err });
    await db.job.update({
      where: { id: job.id },
      data: retry
        ? { status: "QUEUED", runAfter: new Date(Date.now() + 30_000 * job.attempts), error: message.slice(0, 1000) }
        : { status: "FAILED", finishedAt: new Date(), error: message.slice(0, 1000) },
    });
    if (!retry && job.type === "PROCESS_FINAL") await markFinalFailed((job.payload as { assetId: string }).assetId, message).catch(() => undefined);
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (let i = 0; i < 5; i++) {
      const job = await claimNext();
      if (!job) break;
      await runJob(job);
    }
  } catch (err) {
    log.error("job worker tick failed", { err });
  } finally {
    busy = false;
  }
}

/** Periodic housekeeping: stale locks, missed derivatives, trash purge, expired exports. */
async function maintenance() {
  try {
    await db.job.updateMany({
      where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
      data: { status: "QUEUED" },
    });

    const unprocessed = await db.photoAsset.findMany({
      where: {
        processingStatus: "PENDING",
        createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
        files: { some: { role: "PRIMARY", uploadStatus: "VERIFIED" } },
      },
      select: { id: true, organizationId: true },
      take: 50,
    });
    for (const a of unprocessed) {
      const exists = await db.job.findFirst({
        where: { type: "PROCESS_ASSET", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["assetId"], equals: a.id } },
      });
      if (!exists) await db.job.create({ data: { organizationId: a.organizationId, type: "PROCESS_ASSET", payload: { assetId: a.id } } });
    }

    const orgs = await db.organization.findMany({ select: { id: true, trashRetentionDays: true } });
    for (const org of orgs) {
      await purgeExpiredTrash(org.id, org.trashRetentionDays);
      await resumeStalledDeletions(org.id);
    }

    // a preview exists but the full-resolution pass was lost (restart, deleted job) → queue it again
    const stuck = await db.photoAsset.findMany({
      where: { imageState: "PREVIEW_READY", updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }, deletedAt: null },
      select: { id: true, organizationId: true },
      take: 50,
    });
    for (const a of stuck) {
      const active = await db.job.findFirst({
        where: { type: "PROCESS_FINAL", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["assetId"], equals: a.id } },
        select: { id: true },
      });
      if (!active) await enqueueFinalStage(a.organizationId, a.id);
    }

    const expired = await db.job.findMany({
      where: { type: "EXPORT_ZIP", expiresAt: { lt: new Date() }, resultKey: { not: null } },
      take: 100,
    });
    for (const job of expired) {
      await storage().delete(job.resultKey!).catch(() => undefined);
      await db.job.update({ where: { id: job.id }, data: { resultKey: null } });
    }
  } catch (err) {
    log.error("maintenance failed", { err });
  }
}

export function startJobWorker() {
  if (started) return;
  started = true;
  log.info("job worker started");
  setInterval(tick, POLL_MS).unref();
  setInterval(maintenance, MAINTENANCE_MS).unref();
  setTimeout(maintenance, 15_000).unref();
}
