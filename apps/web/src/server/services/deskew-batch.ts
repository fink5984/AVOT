import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { photoProcessingSchema, type PhotoProcessing } from "@avot/shared";
import { db } from "../db";
import { log } from "../log";
import { keys, storage } from "../storage";
import { analyzeDeskew, processBook } from "./book-image";
import { deriveImages, flattenColor, parseProcessing, processingFingerprint, resultInfo } from "./derivatives";
import { DESKEW_ALGO_VERSION, DESKEW_LIMITS, skipped, type DeskewDecision } from "@/lib/imaging/deskew";
import { verdictOf, type ReportRow } from "@/lib/imaging/deskew-report";

/*
 * Straightening of photos that already exist. One engine: the examination is `analyzeDeskew` and the rotation is
 * `processBook` — exactly what a new photo goes through — applied to the stored PRIMARY original, never to an
 * already-processed file, so rotations cannot accumulate. Nothing is overwritten: a changed photo gets NEW object
 * keys and the database row is flipped to them only after they were written and read back; the previous version's
 * keys and fields are kept on the batch item, which is what a rollback restores.
 */

export const MAX_ATTEMPTS = 3;

/** what the photo row looked like before a batch item changed it */
export interface PreviousVersion {
  processedKey: string | null;
  processedMime: string | null;
  processedWidth: number | null;
  processedHeight: number | null;
  thumbKey: string | null;
  previewKey: string | null;
  imageState: string;
  processingResult: unknown;
}

interface NewKeys {
  processed: string;
  thumb: string;
  preview: string;
}

type AssetRow = Awaited<ReturnType<typeof loadAsset>>;

async function loadAsset(assetId: string) {
  return db.photoAsset.findUnique({
    where: { id: assetId },
    include: { files: true, item: { select: { inventoryNumber: true, itemType: true } } },
  });
}

/** why a photo is not examined at all (null = examine it) */
export function preSkip(asset: NonNullable<AssetRow>, force: boolean): { verdict: ReportRow["verdict"]; reason: string } | null {
  const processing = parseProcessing(asset.processing);
  if (asset.deletedAt || !asset.processedKey || !processing || (asset.imageState !== "DONE" && asset.imageState !== "NEEDS_REVIEW")) {
    return { verdict: "not-processed", reason: "not-processed" };
  }
  const e = processing.edits;
  if (e?.crop || (e?.strokes?.length ?? 0) > 0) return { verdict: "manual-edits", reason: "manual-edits" };
  // examined by the detection already (a new photo, or an earlier batch)? "disabled" / "manual-edits" mean it was NOT looked at
  const done = (asset.processingResult as { deskew?: { algo?: number; skip?: string | null } } | null)?.deskew;
  const looked = done?.algo !== undefined && done.skip !== "disabled" && done.skip !== "manual-edits";
  if (!force && looked && done!.algo! >= DESKEW_ALGO_VERSION) return { verdict: "already-checked", reason: "already-checked" };
  return null;
}

function primaryOf(asset: NonNullable<AssetRow>) {
  return asset.files.find((f) => f.role === "PRIMARY" && f.uploadStatus === "VERIFIED") ?? null;
}

/** The stored settings with straightening switched on — the photo's other settings (rotation, margin …) stay as captured. */
function withDeskew(p: PhotoProcessing): PhotoProcessing {
  return photoProcessingSchema.parse({ ...p, settings: { ...p.settings, autoDeskew: true } });
}

/** the original is the source of truth: it must be there and match the checksum recorded at upload */
async function readOriginal(file: { storageKey: string; sha256: string }): Promise<Buffer> {
  const buffer = await storage().getBuffer(file.storageKey);
  const sum = createHash("sha256").update(buffer).digest("hex");
  if (sum !== file.sha256) throw new OriginalCorrupt(`checksum of ${file.storageKey} differs from the one recorded at upload`);
  return buffer;
}

export class OriginalCorrupt extends Error {}

/* ---------------------------- examination (no writes) ---------------------------- */

export interface ExamineOptions {
  limit?: number;
  force?: boolean;
  /** only these photos (sample runs) */
  assetIds?: string[];
  onRow?: (row: ReportRow, index: number) => void;
  shouldStop?: () => boolean;
}

/** Candidate photo ids in a stable order, 200 at a time. */
async function* candidateIds(orgId: string, assetIds?: string[]): AsyncGenerator<string> {
  let cursor: string | undefined;
  for (;;) {
    const page = await db.photoAsset.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        processedKey: { not: null },
        imageState: { in: ["DONE", "NEEDS_REVIEW"] },
        ...(assetIds ? { id: { in: assetIds } } : {}),
      },
      orderBy: { id: "asc" },
      take: 200,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true },
    });
    if (page.length === 0) return;
    for (const p of page) yield p.id;
    cursor = page[page.length - 1]!.id;
  }
}

function rowOf(asset: NonNullable<AssetRow>, d: DeskewDecision, extra: Partial<ReportRow> = {}): ReportRow {
  return {
    assetId: asset.id,
    inventoryNumber: asset.item?.inventoryNumber ?? null,
    itemType: asset.item?.itemType ?? null,
    category: asset.category,
    verdict: verdictOf(d),
    angle: d.angle,
    tilt: Number(d.tilt.toFixed(2)),
    confidence: Number(d.confidence.toFixed(2)),
    kind: d.kind,
    skip: d.skip,
    ...extra,
  };
}

/** Dry run: reads originals and measures; writes nothing, anywhere. */
export async function examineAll(orgId: string, opts: ExamineOptions = {}): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];
  let n = 0;
  for await (const id of candidateIds(orgId, opts.assetIds)) {
    if (opts.shouldStop?.() || (opts.limit && n >= opts.limit)) break;
    const asset = await loadAsset(id);
    if (!asset) continue;
    const t = Date.now();
    let row: ReportRow;
    const skip = preSkip(asset, opts.force ?? false);
    if (skip) {
      row = rowOf(asset, skipped("manual-edits"), { verdict: skip.verdict, skip: skip.reason, kind: null });
    } else {
      try {
        const primary = primaryOf(asset);
        if (!primary) throw new Error("no verified original");
        const a = await analyzeDeskew(await readOriginal(primary), withDeskew(parseProcessing(asset.processing)!));
        row = rowOf(asset, a.decision, { ms: Date.now() - t });
      } catch (err) {
        row = rowOf(asset, skipped("no-object"), { verdict: "error", error: err instanceof Error ? err.message.slice(0, 200) : String(err), kind: null, skip: null });
      }
    }
    rows.push(row);
    opts.onRow?.(row, n);
    n++;
  }
  return rows;
}

/** Before / after of one photo for the comparison page — the after image is rendered exactly as the batch would write it, and thrown away. */
export async function renderComparison(assetId: string, width = 640): Promise<{ before: Buffer | null; after: Buffer; decision: ReportRow["verdict"]; angle: number; confidence: number; skip: string | null; kind: string }> {
  const asset = await loadAsset(assetId);
  if (!asset) throw new Error("photo not found");
  const primary = primaryOf(asset);
  const processing = parseProcessing(asset.processing);
  if (!primary || !processing) throw new Error("photo has no original or settings");
  const input = await readOriginal(primary);
  const book = await processBook(input, withDeskew(processing), "full");
  const flat = flattenColor(processing);
  const small = (b: Buffer) => sharp(b).resize({ width, height: width, fit: "inside", withoutEnlargement: true }).flatten({ background: flat }).jpeg({ quality: 82 }).toBuffer();
  const before = asset.processedKey ? await storage().getBuffer(asset.processedKey).then(small, () => null) : null;
  const d = book.deskew;
  return {
    before,
    after: await small(book.data),
    decision: d.applied ? "can-straighten" : verdictOf({ kind: d.kind, tilt: d.tilt, angle: d.angle, confidence: d.confidence, apply: d.applied, skip: d.skip, metrics: { peakShare: 0, solidity: 0, rectFill: 0, estimateGap: 0, objects: 0 } }),
    angle: d.angle,
    confidence: d.confidence,
    skip: d.skip,
    kind: d.kind,
  };
}

/* ---------------------------- batches ---------------------------- */

export interface PlanOptions {
  limit?: number;
  force?: boolean;
  startedBy?: string;
  note?: string;
}

/**
 * Creates the batch and its items. Photos already handled by this algorithm version (applied, examined without a
 * change, or rolled back) are not planned again unless `force`. Photos that cannot be examined get a SKIPPED item
 * right away so the totals add up.
 */
export async function planBatch(orgId: string, opts: PlanOptions = {}) {
  const batch = await db.deskewBatch.create({
    data: { organizationId: orgId, algoVersion: DESKEW_ALGO_VERSION, params: { limits: DESKEW_LIMITS, force: opts.force ?? false, limit: opts.limit ?? null, startedBy: opts.startedBy ?? null, note: opts.note ?? null } as object },
  });
  const handled = new Set<string>();
  if (!opts.force) {
    const prior = await db.deskewBatchItem.findMany({
      where: { status: { in: ["APPLIED", "SKIPPED", "ROLLED_BACK"] }, batch: { organizationId: orgId, algoVersion: { gte: DESKEW_ALGO_VERSION } } },
      select: { assetId: true },
    });
    for (const p of prior) handled.add(p.assetId);
  }
  let planned = 0;
  let pre = 0;
  for await (const id of candidateIds(orgId)) {
    if (opts.limit && planned >= opts.limit) break;
    if (handled.has(id)) continue;
    const asset = await loadAsset(id);
    if (!asset) continue;
    const skip = preSkip(asset, opts.force ?? false);
    await db.deskewBatchItem.create({
      data: skip ? { batchId: batch.id, assetId: id, status: "SKIPPED", skipReason: skip.reason, processedAt: new Date() } : { batchId: batch.id, assetId: id },
    });
    if (skip) pre++;
    else planned++;
  }
  return { batch, planned, preSkipped: pre };
}

export interface RunOptions {
  /** wait between photos — leaves CPU for the web server */
  pauseMs?: number;
  /** stop (pause) when the process grows beyond this */
  maxRssMb?: number;
  /** stop after this many photos in this call (small-batch runs) */
  maxItems?: number;
  onProgress?: (p: BatchProgress) => void;
  shouldStop?: () => boolean;
}

export interface BatchProgress {
  batchId: string;
  status: string;
  total: number;
  pending: number;
  applied: number;
  skipped: number;
  failed: number;
  rolledBack: number;
}

export async function batchProgress(batchId: string): Promise<BatchProgress> {
  const batch = await db.deskewBatch.findUniqueOrThrow({ where: { id: batchId }, select: { status: true } });
  const groups = await db.deskewBatchItem.groupBy({ by: ["status"], where: { batchId }, _count: true });
  const n = (s: string) => groups.find((g) => g.status === s)?._count ?? 0;
  return {
    batchId,
    status: batch.status,
    total: groups.reduce((a, g) => a + g._count, 0),
    pending: n("PENDING") + n("PROCESSING"),
    applied: n("APPLIED"),
    skipped: n("SKIPPED"),
    failed: n("FAILED"),
    rolledBack: n("ROLLED_BACK"),
  };
}

/** After a crash: an item left PROCESSING either got as far as flipping the photo (then it is APPLIED) or goes back to PENDING. */
async function recover(batchId: string) {
  const stuck = await db.deskewBatchItem.findMany({ where: { batchId, status: "PROCESSING" } });
  for (const item of stuck) {
    const nk = item.newKeys as NewKeys | null;
    const asset = nk ? await db.photoAsset.findUnique({ where: { id: item.assetId }, select: { processedKey: true } }) : null;
    if (nk && asset?.processedKey === nk.processed) await db.deskewBatchItem.update({ where: { id: item.id }, data: { status: "APPLIED", changed: true, processedAt: new Date() } });
    else await db.deskewBatchItem.update({ where: { id: item.id }, data: { status: "PENDING" } });
  }
}

export async function setBatchStatus(batchId: string, status: "RUNNING" | "PAUSED") {
  await db.deskewBatch.updateMany({ where: { id: batchId, status: { in: ["RUNNING", "PAUSED"] } }, data: { status } });
}

/** Processes pending items one at a time until done, paused, stopped or over the limits. Safe to call again at any time. */
export async function runBatch(batchId: string, opts: RunOptions = {}): Promise<BatchProgress> {
  const batch = await db.deskewBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status === "ROLLED_BACK") throw new Error("this batch was rolled back");
  await recover(batchId);
  await setBatchStatus(batchId, "RUNNING");
  let done = 0;
  for (;;) {
    const current = await db.deskewBatch.findUniqueOrThrow({ where: { id: batchId }, select: { status: true } });
    if (current.status !== "RUNNING" || opts.shouldStop?.()) break;
    if (opts.maxItems && done >= opts.maxItems) break;
    const item = await db.deskewBatchItem.findFirst({ where: { batchId, status: "PENDING" }, orderBy: [{ attempts: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    if (!item) {
      await db.deskewBatch.update({ where: { id: batchId }, data: { status: "COMPLETED", finishedAt: new Date() } });
      break;
    }
    const claimed = await db.deskewBatchItem.updateMany({ where: { id: item.id, status: "PENDING" }, data: { status: "PROCESSING", attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    await processItem(batchId, item.id, item.attempts + 1);
    done++;
    opts.onProgress?.(await batchProgress(batchId));
    if (opts.maxRssMb && process.memoryUsage().rss / 1048576 > opts.maxRssMb) {
      (globalThis as { gc?: () => void }).gc?.();
      if (process.memoryUsage().rss / 1048576 > opts.maxRssMb) {
        await setBatchStatus(batchId, "PAUSED");
        log.warn("deskew batch paused: memory limit", { batchId, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
        break;
      }
    }
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return batchProgress(batchId);
}

async function processItem(batchId: string, itemId: string, attempt: number) {
  const started = Date.now();
  const item = await db.deskewBatchItem.findUniqueOrThrow({ where: { id: itemId } });
  const finish = (data: Prisma.DeskewBatchItemUpdateInput) => db.deskewBatchItem.update({ where: { id: itemId }, data: { ms: Date.now() - started, processedAt: new Date(), ...data } });
  try {
    const asset = await loadAsset(item.assetId);
    if (!asset) return void (await finish({ status: "SKIPPED", skipReason: "photo-gone" }));
    const pre = preSkip(asset, true); // a planned item is examined even when an older algorithm version already looked at it
    if (pre) return void (await finish({ status: "SKIPPED", skipReason: pre.reason }));
    const primary = primaryOf(asset);
    if (!primary) return void (await finish({ status: "SKIPPED", skipReason: "no-original" }));
    const stored = parseProcessing(asset.processing)!;
    const input = await readOriginal(primary);
    const book = await processBook(input, withDeskew(stored), "full");
    const d = book.deskew;
    const common = { kind: d.kind, tilt: d.tilt, angle: d.angle, confidence: d.confidence };
    if (!d.applied) return void (await finish({ status: "SKIPPED", skipReason: d.skip ?? "not-applied", ...common }));

    // 1. write the new files under NEW keys, 2. read them back, 3. only then flip the row
    const tag = `dsk${batchId.slice(0, 8)}`;
    const nk: NewKeys = {
      processed: `orgs/${asset.organizationId}/processed/${asset.id}/book.${tag}.${book.ext}`,
      thumb: `orgs/${asset.organizationId}/derived/${asset.id}/thumb.${tag}.webp`,
      preview: `orgs/${asset.organizationId}/derived/${asset.id}/preview.${tag}.jpg`,
    };
    const { thumb, preview } = await deriveImages(book.data, flattenColor(stored));
    const store = storage();
    await store.putBuffer(nk.processed, book.data, book.mime);
    await store.putBuffer(nk.thumb, thumb, "image/webp");
    await store.putBuffer(nk.preview, preview, "image/jpeg");
    const back = await store.getBuffer(nk.processed);
    const meta = await sharp(back).metadata();
    if (createHash("sha256").update(back).digest("hex") !== createHash("sha256").update(book.data).digest("hex") || meta.width !== book.width || meta.height !== book.height) {
      throw new Error("verification of the new processed file failed");
    }

    const previous: PreviousVersion = {
      processedKey: asset.processedKey,
      processedMime: asset.processedMime,
      processedWidth: asset.processedWidth,
      processedHeight: asset.processedHeight,
      thumbKey: asset.thumbKey,
      previewKey: asset.previewKey,
      imageState: asset.imageState,
      processingResult: asset.processingResult,
    };
    // recorded BEFORE the flip: a crash between the two is recovered from this
    await db.deskewBatchItem.update({ where: { id: itemId }, data: { previous: previous as object, newKeys: nk as object, ...common } });
    const info = { ...resultInfo(book, stored), batch: batchId };
    // the photo must still be exactly what was examined (nobody re-edited it meanwhile)
    const fresh = await db.photoAsset.findUnique({ where: { id: asset.id }, select: { processing: true, processedKey: true, imageState: true, deletedAt: true } });
    const freshProcessing = fresh ? parseProcessing(fresh.processing) : null;
    if (!fresh || fresh.deletedAt || fresh.processedKey !== previous.processedKey || fresh.imageState !== previous.imageState || !freshProcessing || processingFingerprint(freshProcessing) !== processingFingerprint(stored)) {
      throw new Error("the photo changed while it was being straightened");
    }
    const flipped = await db.photoAsset.updateMany({
      where: { id: asset.id, processedKey: previous.processedKey, imageState: asset.imageState },
      data: {
        processedKey: nk.processed,
        processedMime: book.mime,
        processedWidth: book.width,
        processedHeight: book.height,
        thumbKey: nk.thumb,
        previewKey: nk.preview,
        imageState: book.status,
        processingResult: info as object,
      },
    });
    if (flipped.count === 0) return void (await finish({ status: "SKIPPED", skipReason: "changed-meanwhile", ...common }));
    await finish({ status: "APPLIED", changed: true, ...common });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    const permanent = err instanceof OriginalCorrupt || attempt >= MAX_ATTEMPTS;
    log.warn("deskew item failed", { batchId, itemId, attempt, err });
    await finish({ status: permanent ? "FAILED" : "PENDING", error: message });
  }
}

/** Puts every photo the batch changed back to the version it had before. New files stay in storage (never deleted). */
export async function rollbackBatch(batchId: string): Promise<{ restored: number; notRestored: { assetId: string; reason: string }[] }> {
  await db.deskewBatch.findUniqueOrThrow({ where: { id: batchId } });
  await setBatchStatus(batchId, "PAUSED"); // nothing new is applied while rolling back
  await recover(batchId);
  const items = await db.deskewBatchItem.findMany({ where: { batchId, status: "APPLIED" } });
  let restored = 0;
  const notRestored: { assetId: string; reason: string }[] = [];
  for (const item of items) {
    const prev = item.previous as PreviousVersion | null;
    const nk = item.newKeys as NewKeys | null;
    if (!prev || !nk) {
      notRestored.push({ assetId: item.assetId, reason: "no snapshot" });
      continue;
    }
    // restore only if the photo still points at what this batch wrote; a later manual edit wins
    const r = await db.photoAsset.updateMany({
      where: { id: item.assetId, processedKey: nk.processed },
      data: {
        processedKey: prev.processedKey,
        processedMime: prev.processedMime,
        processedWidth: prev.processedWidth,
        processedHeight: prev.processedHeight,
        thumbKey: prev.thumbKey,
        previewKey: prev.previewKey,
        imageState: prev.imageState as never,
        processingResult: prev.processingResult === null ? Prisma.DbNull : (prev.processingResult as object),
      },
    });
    if (r.count === 1) {
      restored++;
      await db.deskewBatchItem.update({ where: { id: item.id }, data: { status: "ROLLED_BACK" } });
    } else {
      notRestored.push({ assetId: item.assetId, reason: "the photo was edited after the batch — left as it is now" });
    }
  }
  if (notRestored.length === 0) {
    await db.deskewBatch.update({ where: { id: batchId }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
    // anything still waiting will never run
    await db.deskewBatchItem.updateMany({ where: { batchId, status: "PENDING" }, data: { status: "SKIPPED", skipReason: "batch-rolled-back" } });
  }
  return { restored, notRestored };
}
