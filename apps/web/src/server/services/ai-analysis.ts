import "server-only";
import { z } from "zod";
import { Prisma, type InventoryAnalysis, type InventoryItem, type Job } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import { asJson } from "../json";
import { can } from "../auth/permissions";
import type { DevicePrincipal, UserPrincipal } from "../auth/principal";
import { hashPassword, verifyPassword } from "../auth/password";
import { assertFailureBudget, recordFailure } from "../rate-limit";
import { he } from "@/i18n/he";
import { changeStatus } from "./item-status";
import { LOT_COPY_FIELDS } from "./inventory";
import { reviewAfterHumanEdit } from "./item-review";
import { activeProvider, aiConfig, type AiConfig } from "../ai/config";
import { batchImages, photosFingerprint, prepareImages, type PreparedImage } from "../ai/images";
import { AI_MAX_LENGTH, AI_WRITABLE, mapResult, type AiValues, type AiWritable } from "../ai/mapper";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../ai/catalog-prompt";
import { buildAnalysisText, buildInstructions, buildObservationText, cacheKeyFor, redactPersonal, type ItemContext } from "../ai/prompt-builder";
import { ANALYSIS_JSON_SCHEMA, analysisResultZ, InvalidAnswerError, OBSERVATION_JSON_SCHEMA, observationResultZ, parseAnswer, type AnalysisResult, type ObservationResult } from "../ai/schema";
import { estimateTokens, loadStyleLibrary } from "../ai/style-examples";
import { computeCost, type UsageTotals } from "../ai/pricing";
import { providerForRun, type AiProvider } from "../ai/providers";
import { ProviderError, type ProviderRequest, type ProviderResponse } from "../ai/providers/types";
import { cleanAiText, sameText } from "../ai/text";

/*
 * AI analysis of one inventory item ("catalog_ai" runs in InventoryAnalysis).
 *
 * Request (HTTP, quick): permission + organization check, a manager's password approval when the item already had a
 * successful analysis, then ONE transaction that creates the run, its AI_ANALYZE job and sets item.aiStatus = QUEUED.
 * Duplicates are impossible: the click carries a request key (unique per organization), the item row is locked,
 * and a partial unique index allows one QUEUED/RUNNING run per item.
 *
 * Job (background worker): claims the run (a stale RUNNING run is taken over after a crash), prepares images,
 * calls the active provider (staged when the images do not fit one request), validates the JSON, and only then
 * writes - in one transaction that also stores the snapshot, the run result, the review status and
 * item.aiStatus = COMPLETED. On any failure nothing on the item changes except aiStatus = FAILED + the message;
 * usage that was already paid for is still recorded on the run.
 */

export const AI_KIND = "catalog_ai";
/** a RUNNING run not touched for this long is considered abandoned (worker crash) and may be taken over */
const RUN_STALE_MS = 10 * 60 * 1000;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;
const PROVIDER_ATTEMPTS = 3;

/** Error after which the worker must not retry the job (the run is already marked FAILED). */
export class AiRunFailed extends Error {
  readonly noRetry = true;
}

/* ───────────────────────── values ───────────────────────── */

export function aiValuesOf(item: Pick<InventoryItem, AiWritable>): AiValues {
  return Object.fromEntries(AI_WRITABLE.map((f) => [f, item[f] ?? null])) as AiValues;
}

/** Fields whose value is still what the previous successful AI run wrote (no person changed it since). */
export async function aiFilledFields(item: InventoryItem): Promise<string[]> {
  const previous = await db.inventoryAnalysis.findFirst({
    where: { inventoryItemId: item.id, kind: AI_KIND, status: "COMPLETED", restoredAt: null },
    orderBy: { finishedAt: "desc" },
    select: { applied: true },
  });
  const written = ((previous?.applied as AppliedReport | null)?.written ?? {}) as Partial<AiValues>;
  const now = aiValuesOf(item);
  return (Object.keys(written) as AiWritable[]).filter((f) => f !== "itemType" && written[f] !== null && written[f] !== undefined && sameText(String(written[f]), now[f] as string | null));
}

export function itemContext(item: InventoryItem, categoryNotes: { category: string; note: string | null }[], aiFilled: string[] = []): ItemContext {
  return {
    aiFilled,
    itemType: item.itemType === "UNKNOWN" ? null : he.itemType[item.itemType],
    title: item.title,
    subtitle: item.subtitle,
    author: item.author,
    printPlace: item.printPlace,
    printYear: item.printYear,
    publisher: item.publisher,
    edition: item.edition,
    extent: item.extent,
    bibliographicNotes: redactPersonal(item.bibliographicNotes),
    conditionNotes: redactPersonal(item.conditionNotes),
    dimensionsMm: item.heightMm || item.widthMm || item.depthMm ? { height: item.heightMm, width: item.widthMm, depth: item.depthMm } : null,
    photographerNotes: redactPersonal(item.photographerNotes),
    categoryNotes: categoryNotes
      .filter((c) => c.note?.trim())
      .map((c) => ({ category: he.category[c.category as keyof typeof he.category] ?? c.category, note: redactPersonal(c.note)! })),
  };
}

/* ───────────────────────── state for the UI ───────────────────────── */

export interface AiRunSummary {
  id: string;
  status: InventoryAnalysis["status"];
  provider: string | null;
  model: string | null;
  isReanalysis: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  imageCount: number;
  requestCount: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  error: string | null;
  promptVersion: string | null;
  examplesVersion: string | null;
  restoredAt: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
}

function runSummary(r: InventoryAnalysis, names: Map<string, string>): AiRunSummary {
  return {
    id: r.id,
    status: r.status,
    provider: r.provider,
    model: r.model,
    isReanalysis: r.isReanalysis,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs,
    imageCount: r.imageCount,
    requestCount: r.requestCount,
    inputTokens: r.inputTokens,
    cachedInputTokens: r.cachedInputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    costEstimated: r.costEstimated,
    error: r.error,
    promptVersion: r.promptVersion,
    examplesVersion: r.examplesVersion,
    restoredAt: r.restoredAt?.toISOString() ?? null,
    requestedBy: r.createdById ? (names.get(r.createdById) ?? null) : null,
    approvedBy: r.approvedById ? (names.get(r.approvedById) ?? null) : null,
  };
}

/** What the AI button and the review panel need; reflects the database (survives a page refresh). */
export async function getAiState(user: UserPrincipal, itemId: string) {
  const item = await db.inventoryItem.findFirst({
    where: { id: itemId, organizationId: user.organizationId },
    select: { id: true, aiStatus: true, aiRunId: true, aiCompletedAt: true, aiError: true, reviewStatus: true, reviewChangedAt: true, reviewChangedById: true, approvedAt: true, approvedById: true, detailsVersion: true },
  });
  if (!item) throw notFound("הספר");
  const runs = await db.inventoryAnalysis.findMany({ where: { inventoryItemId: itemId, kind: AI_KIND }, orderBy: { createdAt: "desc" }, take: 20 });
  const userIds = [...new Set([...runs.flatMap((r) => [r.createdById, r.approvedById]), item.reviewChangedById, item.approvedById].filter((x): x is string => !!x))];
  const names = new Map((await db.user.findMany({ where: { id: { in: userIds }, organizationId: user.organizationId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const latest = runs.find((r) => r.status === "COMPLETED" && r.restoredAt === null) ?? null;
  let available = true;
  try {
    activeProvider();
  } catch {
    available = false;
  }
  return {
    aiStatus: item.aiStatus,
    aiError: item.aiError,
    hasSuccessfulAnalysis: item.aiCompletedAt !== null,
    /** a new run would replace AI details: a manager must approve it */
    needsApproval: item.aiCompletedAt !== null,
    available,
    reviewStatus: item.reviewStatus,
    reviewChangedAt: item.reviewChangedAt?.toISOString() ?? null,
    reviewChangedBy: item.reviewChangedById ? (names.get(item.reviewChangedById) ?? null) : null,
    approvedAt: item.approvedAt?.toISOString() ?? null,
    approvedBy: item.approvedById ? (names.get(item.approvedById) ?? null) : null,
    detailsVersion: item.detailsVersion,
    runs: runs.map((r) => runSummary(r, names)),
    /** the result the item's current AI details come from (evidence, confidence, review notes) */
    latest: latest
      ? {
          id: latest.id,
          result: latest.result as AnalysisResult | null,
          applied: latest.applied as AppliedReport | null,
          images: ((latest.input as { images?: unknown } | null)?.images ?? []) as ImageManifestEntry[],
        }
      : null,
  };
}
export type AiState = Awaited<ReturnType<typeof getAiState>>;

/* ───────────────────────── request ───────────────────────── */

export const requestSchema = z.object({
  /** client key of this click (double click / retry → the same run) */
  requestKey: z.string().uuid(),
  /** re-analysis only: the approving manager re-enters their credentials */
  approval: z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().min(1).max(200) }).optional(),
});

let dummyHash: Promise<string> | undefined;

/**
 * A manager's approval: email + password of an ACTIVE user of the same organization with ai.reanalyze.approve,
 * verified on the server with the login's scrypt check. Failures are rate limited per requesting user and per
 * approver email, and logged (never the password).
 */
async function verifyApproval(user: UserPrincipal, itemId: string, approval: { email: string; password: string }) {
  const userKey = `ai-approve:user:${user.userId}`;
  const emailKey = `ai-approve:email:${approval.email}`;
  assertFailureBudget(userKey, 5, APPROVAL_WINDOW_MS);
  assertFailureBudget(emailKey, 5, APPROVAL_WINDOW_MS);
  const approver = await db.user.findUnique({ where: { email: approval.email } });
  const ok = approver?.passwordHash
    ? await verifyPassword(approval.password, approver.passwordHash)
    : (await verifyPassword(approval.password, await (dummyHash ??= hashPassword("not-a-real-password"))), false);
  const valid = ok && approver && approver.organizationId === user.organizationId && approver.status === "ACTIVE" && can(approver.role, "ai.reanalyze.approve");
  if (!valid || !approver) {
    recordFailure(userKey, APPROVAL_WINDOW_MS);
    recordFailure(emailKey, APPROVAL_WINDOW_MS);
    await audit(user, { action: "ai.reanalysis_denied", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { approverEmail: approval.email } });
    // 403, not 401: a failed approval must not log the requesting user out
    throw new AppError("FORBIDDEN", "אימות המנהל נכשל: אימייל או סיסמה שגויים, או שלמשתמש אין הרשאת מנהל לאישור ניתוח חוזר.");
  }
  return approver;
}

export async function requestAnalysis(user: UserPrincipal, itemId: string, input: z.infer<typeof requestSchema>) {
  const prior = await db.inventoryAnalysis.findUnique({ where: { organizationId_requestKey: { organizationId: user.organizationId, requestKey: input.requestKey } } });
  if (prior) {
    if (prior.inventoryItemId !== itemId) throw new AppError("CONFLICT", "מפתח הבקשה כבר שימש לפריט אחר");
    return { runId: prior.id, existing: true };
  }
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId } });
  if (!item) throw notFound("הספר");
  if (item.deletionRequestedAt) throw new AppError("CONFLICT", "הספר ממתין למחיקה");
  const provider = activeProvider(); // clear error when not configured, before anything is queued
  if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI כבר פעיל על הפריט");

  const inline = aiConfig().BOOK_AI_INLINE;
  const isReanalysis = item.aiCompletedAt !== null;
  let approverId: string | null = null;
  if (isReanalysis) {
    if (!input.approval) throw new AppError("FORBIDDEN", "הפריט כבר נותח. ניתוח חוזר דורש אישור מנהל.", { code: "APPROVAL_REQUIRED" });
    approverId = (await verifyApproval(user, itemId, input.approval)).id;
  }

  try {
    const run = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
      const now = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { aiStatus: true, aiCompletedAt: true } });
      if (now.aiStatus === "QUEUED" || now.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI כבר פעיל על הפריט");
      if ((now.aiCompletedAt !== null) !== isReanalysis) throw new AppError("CONFLICT", "מצב הניתוח של הפריט השתנה. רעננו ונסו שוב.");
      const created = await tx.inventoryAnalysis.create({
        data: {
          organizationId: user.organizationId,
          inventoryItemId: itemId,
          kind: AI_KIND,
          status: "QUEUED",
          provider: provider.provider,
          model: provider.model,
          requestKey: input.requestKey,
          isReanalysis,
          approvedById: approverId,
          createdById: user.userId,
        },
      });
      const job = await tx.job.create({
        data: {
          organizationId: user.organizationId,
          type: "AI_ANALYZE",
          payload: { analysisId: created.id, itemId },
          createdById: user.userId,
          ...(inline ? { status: "RUNNING", lockedAt: new Date(), attempts: 1 } : {}),
        },
      });
      await tx.inventoryAnalysis.update({ where: { id: created.id }, data: { jobId: job.id } });
      await tx.inventoryItem.update({ where: { id: itemId }, data: { aiStatus: "QUEUED", aiRunId: created.id, aiError: null } });
      await audit(user, { action: "ai.requested", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { runId: created.id, provider: provider.provider, model: provider.model, reanalysis: isReanalysis } }, tx);
      if (isReanalysis) await audit(user, { action: "ai.reanalysis_approved", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { runId: created.id, approvedById: approverId } }, tx);
      return { ...created, job };
    });
    if (inline) void runInline(run.job);
    return { runId: run.id, existing: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const same = await db.inventoryAnalysis.findUnique({ where: { organizationId_requestKey: { organizationId: user.organizationId, requestKey: input.requestKey } } });
      if (same) return { runId: same.id, existing: true };
      throw new AppError("CONFLICT", "ניתוח AI כבר פעיל על הפריט");
    }
    throw err;
  }
}

/* ───────────────────────── job ───────────────────────── */

interface CallRecord {
  stage: string;
  images: string[];
  attempt: number;
  ok: boolean;
  ms: number;
  error?: string;
  requestId?: string | null;
  model?: string;
  usage?: ProviderResponse["usage"];
}

export interface ImageManifestEntry {
  imageId: string | null;
  assetId: string;
  category: string;
  status: "prepared" | "skipped";
  source?: string;
  reason?: string;
  zooms?: string[];
  sentIn?: string[];
}

export interface AppliedReport {
  written: Partial<Record<AiWritable, string>>;
  decisions: ReturnType<typeof mapResult>["decisions"];
  review: { field: string; reason: string }[];
  warnings: string[];
  lot: { lotId: string; fields: string[]; descriptionVersion: number | null; skippedReason?: string } | null;
  imagesChanged: boolean;
}

class RunContext {
  calls: CallRecord[] = [];
  totals: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, extraReasoningTokens: 0 };
  reasoningTokens = 0;
  usageReported = true;
  model: string | null = null;
  constructor(
    readonly run: InventoryAnalysis,
    readonly job: Job | null,
    readonly cfg: AiConfig,
    readonly provider: AiProvider,
  ) {}

  async heartbeat() {
    await db.inventoryAnalysis.update({ where: { id: this.run.id }, data: { updatedAt: new Date() } });
    if (this.job) await db.job.update({ where: { id: this.job.id }, data: { lockedAt: new Date() } }).catch(() => undefined);
  }

  add(r: ProviderResponse) {
    this.model = r.model;
    if (!r.usage) {
      this.usageReported = false;
      return;
    }
    this.totals.inputTokens += r.usage.inputTokens;
    this.totals.cachedInputTokens += r.usage.cachedInputTokens;
    this.totals.outputTokens += r.usage.outputTokens;
    this.totals.extraReasoningTokens += r.usage.extraReasoningTokens;
    this.reasoningTokens += r.usage.reasoningTokens;
  }

  usageColumns() {
    const cost = computeCost(this.provider.model, this.calls.some((c) => c.ok) ? this.totals : null, { usageReported: this.usageReported });
    return {
      requestCount: this.calls.length,
      inputTokens: this.totals.inputTokens,
      cachedInputTokens: this.totals.cachedInputTokens,
      outputTokens: this.totals.outputTokens + this.totals.extraReasoningTokens,
      reasoningTokens: this.reasoningTokens,
      costUsd: cost.costUsd === null ? null : new Prisma.Decimal(cost.costUsd),
      costEstimated: cost.estimated,
      price: cost.price,
    };
  }

  /** One provider call with retries for rate limits, timeouts and server errors, and one repeat for an invalid answer. */
  async call<T>(stage: string, req: ProviderRequest, validator: z.ZodType<T>): Promise<T> {
    let invalidRepeats = 0;
    for (let attempt = 1; ; attempt++) {
      await this.heartbeat();
      const started = Date.now();
      const rec: CallRecord = { stage, images: req.images.map((i) => i.id), attempt, ok: false, ms: 0 };
      this.calls.push(rec);
      try {
        const res = await this.provider.generate(req);
        rec.ms = Date.now() - started;
        rec.requestId = res.requestId;
        rec.model = res.model;
        rec.usage = res.usage;
        this.add(res); // paid for, whether or not the answer is usable
        const parsed = parseAnswer(res.text, validator);
        rec.ok = true;
        return parsed;
      } catch (err) {
        rec.ms = Date.now() - started;
        rec.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
        if (err instanceof InvalidAnswerError && invalidRepeats < 1) {
          invalidRepeats++;
          continue;
        }
        if (err instanceof ProviderError && err.retryable && attempt < PROVIDER_ATTEMPTS) {
          const wait = err.opts.retryAfterMs ?? 4000 * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
          continue;
        }
        throw err;
      }
    }
  }
}

const IMAGE_TOKEN_ESTIMATE = 1600;

/** BOOK_AI_INLINE: the job was created RUNNING; run it here and close it the way the worker would. */
async function runInline(job: Job) {
  let error: string | null = null;
  try {
    await runAiAnalysisJob(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("inline ai analysis failed", { jobId: job.id, err });
  }
  await db.job.update({ where: { id: job.id }, data: { status: error ? "FAILED" : "SUCCEEDED", finishedAt: new Date(), error } }).catch(() => undefined);
}

/** Worker entry point for AI_ANALYZE jobs. */
export async function runAiAnalysisJob(job: Job) {
  const { analysisId } = job.payload as { analysisId: string };
  await runAnalysis(analysisId, job);
}

export async function runAnalysis(analysisId: string, job: Job | null = null) {
  const startedAt = new Date();
  // claim: a QUEUED run, or a RUNNING one abandoned by a crashed worker. Anything else (finished, or running elsewhere) → nothing to do.
  const claimed = await db.inventoryAnalysis.updateMany({
    where: { id: analysisId, OR: [{ status: "QUEUED" }, { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }] },
    data: { status: "RUNNING", startedAt, updatedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
  await db.inventoryItem.updateMany({ where: { id: run.inventoryItemId, aiRunId: run.id }, data: { aiStatus: "RUNNING" } });

  let ctx: RunContext | null = null;
  try {
    if (job && job.attempts > 3) throw new AppError("INTERNAL", "הניתוח הופסק שוב ושוב (הפעלה מחדש של השרת). נסו שוב.");
    const cfg = aiConfig();
    ctx = new RunContext(run, job, cfg, providerForRun(cfg));
    const result = await analyse(ctx, startedAt);
    log.info("ai analysis completed", { runId: run.id, itemId: run.inventoryItemId, ms: Date.now() - startedAt.getTime(), written: Object.keys(result.written).length });
  } catch (err) {
    const message = err instanceof AppError || err instanceof ProviderError || err instanceof InvalidAnswerError ? err.message : "שגיאה פנימית בניתוח";
    log.warn("ai analysis failed", { runId: run.id, itemId: run.inventoryItemId, err });
    await markFailed(run, message, startedAt, ctx);
    throw new AiRunFailed(message);
  }
}

async function markFailed(run: InventoryAnalysis, message: string, startedAt: Date, ctx: RunContext | null) {
  const usage = ctx?.usageColumns();
  await db.$transaction(async (tx) => {
    await tx.inventoryAnalysis.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: message.slice(0, 1000),
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        ...(usage ? { ...omitPrice(usage), usage: asJson({ calls: ctx!.calls, price: usage.price }) } : {}),
      },
    });
    // only the item's CURRENT run decides its state; its details are never touched on failure
    await tx.inventoryItem.updateMany({ where: { id: run.inventoryItemId, aiRunId: run.id }, data: { aiStatus: "FAILED", aiError: message.slice(0, 500) } });
    await tx.auditLog.create({
      data: { organizationId: run.organizationId, userId: run.createdById, action: "ai.failed", entityType: "inventory", entityId: run.inventoryItemId, inventoryItemId: run.inventoryItemId, data: { runId: run.id, error: message.slice(0, 300), by: "system" } },
    });
  });
}

/** The AI result is written by the system, not by a person: status events carry no user (the requester is on the run). */
const systemPrincipal = (organizationId: string): DevicePrincipal => ({ kind: "device", deviceId: "ai", organizationId, deviceName: "AI" });

const omitPrice = <T extends { price: unknown }>(u: T): Omit<T, "price"> => {
  const { price: _price, ...rest } = u;
  return rest;
};

async function analyse(ctx: RunContext, startedAt: Date): Promise<AppliedReport> {
  const { run, cfg, provider } = ctx;
  const item = await db.inventoryItem.findFirst({ where: { id: run.inventoryItemId, organizationId: run.organizationId }, include: { categoryNotes: true } });
  if (!item) throw new AppError("NOT_FOUND", "הפריט לא נמצא (נמחק?)");
  const base = aiValuesOf(item);
  const context = itemContext(item, item.categoryNotes, await aiFilledFields(item));
  const lib = loadStyleLibrary();
  const prepared = await prepareImages(run.organizationId, item.id, cfg);
  const instructions = buildInstructions(lib);
  const skipped = prepared.report.filter((r) => r.status === "skipped").map((r) => ({ label: `${he.category[r.category]} (תמונה ${r.sequence})`, reason: r.reason ?? "" }));

  const batches = batchImages(prepared.images, cfg.BOOK_AI_MAX_IMAGES_PER_REQUEST, cfg.BOOK_AI_MAX_REQUEST_MB * 1024 * 1024);
  const [finalImages, ...observationBatches] = batches.length ? batches : [[] as PreparedImage[]];
  const sentIn = new Map<string, string[]>();
  const mark = (imgs: PreparedImage[], stage: string) => imgs.forEach((i) => sentIn.set(i.id, [...(sentIn.get(i.id) ?? []), stage]));

  // budget check BEFORE sending: examples are never dropped to make a request fit
  const finalText0 = buildAnalysisText(context, finalImages!, { skipped });
  const estimate = estimateTokens(instructions) + estimateTokens(finalText0) + finalImages!.length * IMAGE_TOKEN_ESTIMATE + (observationBatches.length ? 4000 * observationBatches.length : 0);
  const inputRecord = {
    context,
    images: prepared.report.map((r) => ({ imageId: r.imageId, assetId: r.assetId, category: r.category, status: r.status, source: r.source, reason: r.reason, zooms: r.zooms })),
    imagesFingerprint: prepared.fingerprint,
    stages: batches.length,
    tokenEstimate: { instructions: estimateTokens(SYSTEM_PROMPT), examples: estimateTokens(lib.block), total: estimate },
    examplesSkipped: lib.skipped,
  };
  await db.inventoryAnalysis.update({
    where: { id: run.id },
    data: {
      provider: provider.name,
      model: provider.model,
      promptVersion: PROMPT_VERSION,
      examplesVersion: lib.version,
      examplesHash: lib.hash,
      examplesCount: lib.examples.length,
      imageCount: prepared.images.filter((i) => !i.zoomOf).length,
      baseValues: asJson(base),
      input: asJson(inputRecord),
    },
  });
  if (estimate > cfg.BOOK_AI_MAX_INPUT_TOKENS) {
    throw new AppError("VALIDATION", `הבקשה חורגת ממגבלת הטוקנים שהוגדרה (הערכה ${estimate} מתוך ${cfg.BOOK_AI_MAX_INPUT_TOKENS}). אין להשמיט דוגמאות כתיבה: הגדילו את BOOK_AI_MAX_INPUT_TOKENS או צמצמו את ספריית הדוגמאות.`);
  }
  const toProvider = (imgs: PreparedImage[]) => imgs.map((i) => ({ id: i.id, label: i.label, data: i.data, mime: i.mime, detail: i.detail }));
  const common = { instructions, cacheKey: cacheKeyFor(lib), maxOutputTokens: cfg.BOOK_AI_MAX_OUTPUT_TOKENS, timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000 };

  // stage 1 (only with many images): observations for every batch except the first, which goes with the final request
  const observations: ObservationResult[] = [];
  for (let b = 0; b < observationBatches.length; b++) {
    const imgs = observationBatches[b]!;
    const stage = `observe-${b + 1}`;
    const text = buildObservationText(context, imgs, { index: b + 1, total: observationBatches.length });
    observations.push(await ctx.call(stage, { ...common, userText: text, images: toProvider(imgs), schemaName: "item_observations", schema: OBSERVATION_JSON_SCHEMA as unknown as Record<string, unknown> }, observationResultZ));
    mark(imgs, stage);
  }
  const earlier = observationBatches.flat().filter((i) => !i.zoomOf);
  const finalText = observationBatches.length ? buildAnalysisText(context, finalImages!, { skipped, earlierImages: earlier, observations }) : finalText0;
  const result = await ctx.call("final", { ...common, userText: finalText, images: toProvider(finalImages!), schemaName: "item_analysis", schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown> }, analysisResultZ);
  mark(finalImages!, "final");
  inputRecord.images = inputRecord.images.map((i) => ({ ...i, sentIn: i.imageId ? sentIn.get(i.imageId) : undefined }));

  return applyResult(ctx, item.id, result, { base, inputRecord, imagesFingerprint: prepared.fingerprint, imageIds: new Set(prepared.images.map((i) => i.id)), startedAt, observations });
}

/** Writes a validated result: item fields, catalog draft (and a DRAFT catalog's lot), snapshot, run, review status - atomically. */
async function applyResult(
  ctx: RunContext,
  itemId: string,
  result: AnalysisResult,
  extra: { base: AiValues; inputRecord: object; imagesFingerprint: string; imageIds: Set<string>; startedAt: Date; observations: ObservationResult[] },
): Promise<AppliedReport> {
  const { run } = ctx;
  const imagesChanged = (await photosFingerprint(itemId)) !== extra.imagesFingerprint;
  const usage = ctx.usageColumns();
  return db.$transaction(
    async (tx) => {
      // still our run? (a worker that was presumed dead may come back: only the claimant that started last may write)
      const mine = await tx.$queryRaw<{ status: string; startedAt: Date | null }[]>`SELECT status, "startedAt" FROM "InventoryAnalysis" WHERE id = ${run.id}::uuid FOR UPDATE`;
      if (mine[0]?.status !== "RUNNING" || mine[0].startedAt?.getTime() !== extra.startedAt.getTime()) throw new AppError("CONFLICT", "הניתוח נלקח על ידי תהליך אחר");
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
      const current = aiValuesOf(item);
      const previousRun = await tx.inventoryAnalysis.findFirst({ where: { inventoryItemId: itemId, kind: AI_KIND, status: "COMPLETED", restoredAt: null, id: { not: run.id } }, orderBy: { finishedAt: "desc" }, select: { applied: true } });
      const previousAi = ((previousRun?.applied as AppliedReport | null)?.written ?? null) as Partial<AiValues> | null;
      const catalogIsManual = item.catalogDescriptionSource === "MANUAL" && !!(item.catalogDescription?.trim() || item.catalogHeadline?.trim());
      const mapped = mapResult({ result, current, base: extra.base, previousAi, imageIds: extra.imageIds, catalogIsManual });
      if (imagesChanged) mapped.review.push({ field: "images", reason: "תמונות הפריט השתנו בזמן הניתוח (נוספו, נמחקו או עובדו מחדש). כדאי לבדוק את הפרטים מול התמונות העדכניות." });

      const snapshot: Record<string, unknown> = { values: current, catalogDescriptionSource: item.catalogDescriptionSource, detailsVersion: item.detailsVersion };
      const written = Object.fromEntries(Object.entries(mapped.patch).map(([k, v]) => [k, v])) as Partial<Record<AiWritable, string>>;
      const catalogWritten = mapped.patch.catalogHeadline !== undefined || mapped.patch.catalogDescription !== undefined;
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          ...(mapped.patch as Prisma.InventoryItemUpdateInput),
          ...(catalogWritten ? { catalogDescriptionSource: "AI" as const } : {}),
          detailsVersion: { increment: 1 },
          aiStatus: "COMPLETED",
          aiRunId: run.id,
          aiCompletedAt: new Date(),
          aiError: null,
        },
      });

      const lot = await applyToLot(tx, itemId, current, mapped.patch, run.createdById, snapshot);
      await changeStatus(tx, systemPrincipal(run.organizationId), itemId, "REVIEW", "PENDING_REVIEW", {
        reason: run.isReanalysis ? "ניתוח AI חוזר הושלם" : "ניתוח AI הושלם",
        refType: "ai",
        refId: run.id,
      });

      const applied: AppliedReport = { written, decisions: mapped.decisions, review: mapped.review, warnings: [...mapped.warnings, ...result.warnings], lot, imagesChanged };
      const finishedAt = new Date();
      await tx.inventoryAnalysis.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          model: ctx.model ?? run.model,
          result: asJson(result),
          applied: asJson(applied),
          snapshot: asJson(snapshot),
          input: asJson(extra.inputRecord),
          ...omitPrice(usage),
          usage: asJson({ calls: ctx.calls, price: usage.price, observations: extra.observations.length ? extra.observations : undefined }),
          finishedAt,
          durationMs: finishedAt.getTime() - extra.startedAt.getTime(),
          error: null,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: run.organizationId,
          userId: run.createdById,
          action: "ai.completed",
          entityType: "inventory",
          entityId: itemId,
          inventoryItemId: itemId,
          lotId: lot?.lotId ?? null,
          data: asJson({ runId: run.id, provider: ctx.provider.name, model: ctx.model ?? run.model, fields: Object.keys(written), review: mapped.review.length, costUsd: usage.costUsd?.toNumber() ?? null, by: "system" }),
        },
      });
      return applied;
    },
    { timeout: 30_000 },
  );
}

/** A lot whose presentation the AI may still update: assignment active, catalog not archived, not offered or sold yet. */
function lotIsOpenForAi(lot: { assignmentStatus: string; commercialStatus: string; catalog: { status: string } }) {
  return lot.assignmentStatus === "ACTIVE" && lot.catalog.status !== "ARCHIVED" && lot.commercialStatus === "ASSIGNED";
}

/**
 * The catalog side. Only the item's ACTIVE lot, and only while it is still in preparation for sale (catalog not
 * archived, lot not offered / sold - see lotIsOpenForAi): a lot that was offered is public material and is never
 * changed by the AI. Fields change only where the lot is empty or still holds the item's previous value - a
 * catalog-specific edit is never overwritten - and description changes create a LotDescriptionVersion with source AI
 * (the version history keeps every earlier text). Nothing is sent to any external system.
 */
async function applyToLot(tx: Tx, itemId: string, before: AiValues, patch: Partial<AiValues>, userId: string | null, snapshot: Record<string, unknown>): Promise<AppliedReport["lot"]> {
  const lot = await tx.lot.findFirst({ where: { inventoryItemId: itemId, assignmentStatus: "ACTIVE" }, include: { catalog: { select: { status: true, number: true } } } });
  if (!lot) return null;
  if (!lotIsOpenForAi(lot)) return { lotId: lot.id, fields: [], descriptionVersion: null, skippedReason: `הפריט בקטלוג ${lot.catalog.number} כבר הוצע / נמכר או שהקטלוג בארכיון; התיאור שבקטלוג לא שונה` };
  snapshot.lot = { id: lot.id, title: lot.title, subtitle: lot.subtitle, author: lot.author, printYear: lot.printYear, printPlace: lot.printPlace, shortDescription: lot.shortDescription, description: lot.description };
  const data: Record<string, string | null> = {};
  for (const f of LOT_COPY_FIELDS) {
    if (patch[f] !== undefined && sameText(lot[f], before[f])) data[f] = patch[f] as string;
  }
  if (patch.catalogHeadline !== undefined && (!lot.shortDescription?.trim() || sameText(lot.shortDescription, before.catalogHeadline))) data.shortDescription = cleanAiText(patch.catalogHeadline, 2000);
  if (patch.catalogDescription !== undefined && (!lot.description?.trim() || sameText(lot.description, before.catalogDescription))) data.description = cleanAiText(patch.catalogDescription, AI_MAX_LENGTH.catalogDescription);
  if (!Object.keys(data).length) return { lotId: lot.id, fields: [], descriptionVersion: null };
  const u = await tx.lot.update({ where: { id: lot.id }, data });
  let version: number | null = null;
  if (["title", "shortDescription", "description"].some((k) => k in data)) {
    const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId: lot.id }, _max: { version: true } });
    version = (last._max.version ?? 0) + 1;
    await tx.lotDescriptionVersion.create({ data: { lotId: lot.id, version, title: u.title, shortDescription: u.shortDescription, description: u.description, source: "AI", createdById: userId } });
  }
  return { lotId: lot.id, fields: Object.keys(data), descriptionVersion: version };
}

/* ───────────────────────── restore ───────────────────────── */

/**
 * Puts back the values an AI run replaced (its snapshot), for the fields that run wrote. The values being replaced
 * now are recorded in the audit entry, so a restore can itself be undone by hand. An open lot that still holds the
 * AI text gets the previous text back as a new description version.
 */
export async function restoreRun(user: UserPrincipal, runId: string) {
  const run = await db.inventoryAnalysis.findFirst({ where: { id: runId, organizationId: user.organizationId, kind: AI_KIND } });
  if (!run) throw notFound("הניתוח");
  if (run.status !== "COMPLETED" || !run.snapshot || !run.applied) throw new AppError("CONFLICT", "לניתוח זה אין נקודת שחזור");
  if (run.restoredAt) throw new AppError("CONFLICT", "הניתוח הזה כבר שוחזר");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${run.inventoryItemId}::uuid FOR UPDATE`;
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: run.inventoryItemId } });
    if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI פעיל על הפריט. אפשר לשחזר אחרי שיסתיים.");
    const snap = run.snapshot as { values: AiValues; catalogDescriptionSource: InventoryItem["catalogDescriptionSource"]; lot?: Record<string, string | null> & { id: string } };
    const written = (run.applied as unknown as AppliedReport).written;
    const fields = Object.keys(written) as AiWritable[];
    const now = aiValuesOf(item);
    const data: Record<string, unknown> = {};
    for (const f of fields) data[f] = f === "title" ? (snap.values.title ?? item.title) : snap.values[f];
    const before = Object.fromEntries(fields.map((f) => [f, now[f]]));
    if (fields.some((f) => f === "catalogHeadline" || f === "catalogDescription")) data.catalogDescriptionSource = snap.catalogDescriptionSource;
    await tx.inventoryItem.update({ where: { id: item.id }, data: { ...(data as Prisma.InventoryItemUpdateInput), detailsVersion: { increment: 1 } } });
    await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { restoredAt: new Date(), restoredById: user.userId } });

    let lotVersion: number | null = null;
    const appliedLot = (run.applied as unknown as AppliedReport).lot;
    if (snap.lot && appliedLot?.fields.length) {
      const lot = await tx.lot.findFirst({ where: { id: snap.lot.id, assignmentStatus: "ACTIVE" }, include: { catalog: { select: { status: true } } } });
      if (lot && lotIsOpenForAi(lot)) {
        const lotData: Record<string, string | null> = {};
        for (const f of appliedLot.fields) {
          const aiValue = f === "shortDescription" ? written.catalogHeadline : f === "description" ? written.catalogDescription : written[f as AiWritable];
          if (sameText((lot as unknown as Record<string, string | null>)[f], aiValue ?? null)) lotData[f] = f === "title" ? (snap.lot[f] ?? lot.title) : snap.lot[f] ?? null;
        }
        if (Object.keys(lotData).length) {
          const u = await tx.lot.update({ where: { id: lot.id }, data: lotData });
          if (["title", "shortDescription", "description"].some((k) => k in lotData)) {
            const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId: lot.id }, _max: { version: true } });
            lotVersion = (last._max.version ?? 0) + 1;
            await tx.lotDescriptionVersion.create({ data: { lotId: lot.id, version: lotVersion, title: u.title, shortDescription: u.shortDescription, description: u.description, source: "MANUAL", createdById: user.userId } });
          }
        }
      }
    }
    // the details changed: an approval no longer stands
    await reviewAfterHumanEdit(tx, user, item, fields);
    await audit(user, { action: "ai.restored", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: asJson({ runId: run.id, fields, replacedValues: before, lotVersion }) }, tx);
    return { fields, lotVersion };
  });
}

/* ───────────────────────── maintenance & reporting ───────────────────────── */

/** Runs whose job is gone or finished without them (deleted job, worker bug) are marked FAILED so the button never spins forever. */
export async function recoverOrphanRuns() {
  const open = await db.inventoryAnalysis.findMany({ where: { kind: AI_KIND, status: { in: ["QUEUED", "RUNNING"] }, updatedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }, take: 50 });
  for (const r of open) {
    const job = r.jobId ? await db.job.findUnique({ where: { id: r.jobId }, select: { status: true } }) : null;
    if (job && (job.status === "QUEUED" || job.status === "RUNNING")) continue;
    await markFailed(r, "הניתוח לא הסתיים (המשימה ברקע אבדה). אפשר לנסות שוב.", r.startedAt ?? r.createdAt, null);
  }
}

/** Run data for provider comparison (CSV from /api/ai/runs). */
export async function listRunsForReport(orgId: string, opts: { from?: Date; to?: Date } = {}) {
  const runs = await db.inventoryAnalysis.findMany({
    where: { organizationId: orgId, kind: AI_KIND, createdAt: { gte: opts.from, lte: opts.to } },
    orderBy: { createdAt: "asc" },
    include: { item: { select: { inventoryNumber: true, title: true, itemType: true, reviewStatus: true } } },
    take: 5000,
  });
  return runs.map((r) => {
    const applied = r.applied as AppliedReport | null;
    const outcome = r.reviewOutcome as { aiWritten?: number; changed?: string[]; approvedAt?: string } | null;
    return {
      runId: r.id,
      createdAt: r.createdAt.toISOString(),
      inventoryNumber: r.item.inventoryNumber,
      title: r.item.title,
      itemType: r.item.itemType,
      provider: r.provider ?? "",
      model: r.model ?? "",
      status: r.status,
      reanalysis: r.isReanalysis,
      images: r.imageCount,
      requests: r.requestCount,
      inputTokens: r.inputTokens ?? "",
      cachedInputTokens: r.cachedInputTokens ?? "",
      outputTokens: r.outputTokens ?? "",
      reasoningTokens: r.reasoningTokens ?? "",
      costUsd: r.costUsd === null ? "" : Number(r.costUsd),
      costEstimated: r.costEstimated,
      durationSeconds: r.durationMs === null ? "" : Math.round(r.durationMs / 100) / 10,
      promptVersion: r.promptVersion ?? "",
      examplesVersion: r.examplesVersion ?? "",
      examplesHash: r.examplesHash ?? "",
      fieldsWritten: applied ? Object.keys(applied.written).length : "",
      reviewFlags: applied ? applied.review.length : "",
      reviewStatus: r.item.reviewStatus,
      approvedAt: outcome?.approvedAt ?? "",
      fieldsChangedByReviewer: outcome?.changed?.length ?? "",
      changedFields: outcome?.changed?.join(" ") ?? "",
      restored: !!r.restoredAt,
      error: r.error ?? "",
    };
  });
}
