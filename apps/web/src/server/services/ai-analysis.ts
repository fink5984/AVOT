import "server-only";
import { createHash, randomUUID } from "node:crypto";
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
import { AI_MAX_LENGTH, AI_WRITABLE, mapResult, ensureParagraphs, reviewForApplied, stripImageIds, stripMeasurements, type AiValues, type AiWritable } from "../ai/mapper";
import { CODE_RULES, composeInstructions, PROMPT_VERSION, REWRITE_PROMPT_VERSION } from "../ai/catalog-prompt";
import { applyOps, type FieldValues, type PatchOutcome } from "../ai/patch";
import { baselineStatus, ensureBaseline, type OriginalBaseline } from "../ai/baseline";
import { currentSettingsVersion, getAiSettings, type ResolvedAiSettings } from "../ai/settings";
import { buildAnalysisText, buildInstructions, buildObservationText, cacheKeyFor, HEBREW_AGAIN, HEBREW_ONLY, redactPersonal, type ItemContext } from "../ai/prompt-builder";
import { ANALYSIS_JSON_SCHEMA, analysisResultZ, englishExplanations, InvalidAnswerError, isEnglishProse, REWRITE_FIELDS, REWRITE_JSON_SCHEMA, REWRITE_PATCH_JSON_SCHEMA, rewritePatchZ, rewriteResultZ, AI_FIELD_NAMES, type RewriteField, OBSERVATION_JSON_SCHEMA, observationResultZ, parseAnswer, type AnalysisResult, type ObservationResult } from "../ai/schema";
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

/**
 * What the model is told about the item: the ORIGINAL data (the baseline, set before the first analysis) and the
 * photographer's notes. Never the item's current fields: those may hold an earlier model's output, or text copied or
 * edited from it. Only the measured dimensions (a human measurement, never written by the AI) come from the item.
 */
export function contextFromBaseline(baseline: OriginalBaseline, item: Pick<InventoryItem, "heightMm" | "widthMm" | "depthMm">): ItemContext {
  const f = baseline.fields;
  return {
    itemType: f.itemType && f.itemType !== "UNKNOWN" ? (he.itemType[f.itemType as keyof typeof he.itemType] ?? null) : null,
    title: f.title ?? "",
    subtitle: f.subtitle,
    author: f.author,
    printPlace: f.printPlace,
    printYear: f.printYear,
    publisher: f.publisher,
    edition: f.edition,
    extent: f.extent,
    bibliographicNotes: redactPersonal(f.bibliographicNotes),
    conditionNotes: redactPersonal(f.conditionNotes),
    dimensionsMm: item.heightMm || item.widthMm || item.depthMm ? { height: item.heightMm, width: item.widthMm, depth: item.depthMm } : null,
    photographerNotes: redactPersonal(baseline.photographerNotes),
    categoryNotes: baseline.categoryNotes.map((c) => ({ category: he.category[c.category as keyof typeof he.category] ?? c.category, note: redactPersonal(c.note)! })),
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
  settingsVersion: number | null;
  /** the run's result is on the item (a first analysis, or a result the reviewer applied) */
  applied: boolean;
  /** a completed re-analysis not applied (yet): kept for comparison, the item's fields are untouched */
  pendingApply: boolean;
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
    settingsVersion: r.settingsVersion,
    applied: r.applied !== null,
    pendingApply: r.status === "COMPLETED" && r.applied === null && r.restoredAt === null,
  };
}

/** What the AI button and the review panel need; reflects the database (survives a page refresh). */
export async function getAiState(user: UserPrincipal, itemId: string) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId }, include: { categoryNotes: { select: { category: true, note: true } } } });
  if (!item) throw notFound("הספר");
  const runs = await db.inventoryAnalysis.findMany({ where: { inventoryItemId: itemId, kind: AI_KIND }, orderBy: { createdAt: "desc" }, take: 20 });
  const userIds = [...new Set([...runs.flatMap((r) => [r.createdById, r.approvedById]), item.reviewChangedById, item.approvedById].filter((x): x is string => !!x))];
  const names = new Map((await db.user.findMany({ where: { id: { in: userIds }, organizationId: user.organizationId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  // the evidence panel reads the run the item's CURRENT details come from: an applied run (not a saved comparison)
  const latest = runs.find((r) => r.status === "COMPLETED" && r.restoredAt === null && r.applied !== null) ?? null;
  const settings = await getAiSettings(user.organizationId);
  let available = true;
  try {
    activeProvider(settings.cfg);
  } catch {
    available = false;
  }
  return {
    /** the ONE model every AI action uses now (the "הגדרות AI" tab); shown, never chosen, next to the button */
    activeModel: { provider: settings.provider, model: settings.model, reasoning: settings.reasoning, settingsVersion: settings.version },
    /** the original data a clean re-analysis is built from (or a warning that it could not be fully reconstructed) */
    baseline: await baselineStatus(item),
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
          /** values when the run started: "ביטול ההחלה" of a proposal puts the field back to this */
          base: (latest.baseValues ?? null) as AiValues | null,
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
  // the ONE active provider + model, from the "הגדרות AI" tab (the version is fixed on the run: a later change only affects later runs)
  const settings = await getAiSettings(user.organizationId);
  const provider = activeProvider(settings.cfg); // clear error when not configured, before anything is queued
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
      // the original data is fixed BEFORE the first analysis writes anything (a clean re-analysis is built from it)
      await ensureBaseline(itemId, tx);
      const created = await tx.inventoryAnalysis.create({
        data: {
          organizationId: user.organizationId,
          inventoryItemId: itemId,
          kind: AI_KIND,
          status: "QUEUED",
          provider: provider.provider,
          model: provider.model,
          settingsVersion: settings.version,
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
      await audit(user, { action: "ai.requested", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { runId: created.id, provider: provider.provider, model: provider.model, settingsVersion: settings.version, reanalysis: isReanalysis } }, tx);
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
  /** a result applied from a saved comparison (not at the end of its own run): who, when, which fields were asked for */
  appliedFrom?: { byUserId: string; at: string; requested: string[] };
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
    // the model, reasoning and prompts the run STARTED with (its settings version), whatever the tab says now
    const settings = await getAiSettings(run.organizationId, run.settingsVersion ?? null);
    ctx = new RunContext(run, job, settings.cfg, providerForRun(settings.cfg));
    const result = await analyse(ctx, startedAt, settings);
    log.info("ai analysis completed", { runId: run.id, itemId: run.inventoryItemId, ms: Date.now() - startedAt.getTime(), written: Object.keys(result?.written ?? {}).length, applied: result !== null });
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

/**
 * One analysis. The request is built from the item's ORIGINAL data (baseline) and its photos only, plus the run's
 * settings (prompt, examples): nothing an earlier run produced reaches the model. A re-analysis is a clean, independent
 * run: its result is saved for comparison and does NOT touch the item's fields until a person applies it.
 */
async function analyse(ctx: RunContext, startedAt: Date, settings: ResolvedAiSettings): Promise<AppliedReport | null> {
  const { run, cfg, provider } = ctx;
  const item = await db.inventoryItem.findFirst({ where: { id: run.inventoryItemId, organizationId: run.organizationId }, include: { categoryNotes: true } });
  if (!item) throw new AppError("NOT_FOUND", "הפריט לא נמצא (נמחק?)");
  const base = aiValuesOf(item);
  const baseline = await ensureBaseline(item.id);
  const context = contextFromBaseline(baseline, item);
  const lib = settings.lib;
  const instructions = buildInstructions(lib, settings.parts);
  const contextHash = createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 16);
  const toProvider = (imgs: PreparedImage[]) => imgs.map((i) => ({ id: i.id, label: i.label, data: i.data, mime: i.mime, detail: i.detail }));
  const common = { instructions, cacheKey: cacheKeyFor(lib, settings.instructionHash), maxOutputTokens: cfg.BOOK_AI_MAX_OUTPUT_TOKENS, timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000 };

  /**
   * One full pass: prepare the photos, check the budget, call the model (staged when the photos do not fit one request).
   * `manuscript` = zoomed halves on the first pages (small handwriting, signatures, dates), not only on the title page.
   */
  const pass = async (manuscript: boolean, prefix: string) => {
    const prepared = await prepareImages(run.organizationId, item.id, cfg, { manuscript });
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
      /** the original data the context was built from, and how it was obtained (a partial baseline = a warning in the comparison) */
      baseline: { hash: baseline.hash, source: baseline.source, missing: baseline.missing, capturedAt: baseline.capturedAt },
      settings: { version: settings.version, provider: settings.provider, model: settings.model, reasoning: settings.reasoning, instructionHash: settings.instructionHash },
      contextHash,
      /** one hash for "the same input": context + photos + prompt + examples. Two runs with equal hashes differ only in the model. */
      inputFingerprint: createHash("sha256").update([contextHash, prepared.fingerprint, settings.instructionHash, lib.hash].join("|")).digest("hex").slice(0, 16),
      images: prepared.report.map((r) => ({ imageId: r.imageId, assetId: r.assetId, category: r.category, status: r.status, source: r.source, reason: r.reason, zooms: r.zooms })) as (ImageManifestEntry & { sentIn?: string[] })[],
      imagesFingerprint: prepared.fingerprint,
      stages: batches.length,
      manuscriptPass: manuscript,
      tokenEstimate: { instructions: estimateTokens(composeInstructions(settings.parts)), examples: estimateTokens(lib.block), total: estimate },
      examplesSkipped: lib.skipped,
    };
    await db.inventoryAnalysis.update({
      where: { id: run.id },
      data: {
        provider: provider.name,
        model: provider.model,
        promptVersion: settings.defaultPrompts ? PROMPT_VERSION : `custom-${settings.instructionHash}`,
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

    // stage 1 (only with many images): observations for every batch except the first, which goes with the final request
    const observations: ObservationResult[] = [];
    for (let b = 0; b < observationBatches.length; b++) {
      const imgs = observationBatches[b]!;
      const stage = `${prefix}observe-${b + 1}`;
      const text = buildObservationText(context, imgs, { index: b + 1, total: observationBatches.length });
      observations.push(await ctx.call(stage, { ...common, userText: text, images: toProvider(imgs), schemaName: "item_observations", schema: OBSERVATION_JSON_SCHEMA as unknown as Record<string, unknown> }, observationResultZ));
      mark(imgs, stage);
    }
    const earlier = observationBatches.flat().filter((i) => !i.zoomOf);
    const finalText = observationBatches.length ? buildAnalysisText(context, finalImages!, { skipped, earlierImages: earlier, observations }) : finalText0;
    const finalReq = { ...common, userText: finalText, images: toProvider(finalImages!), schemaName: "item_analysis", schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown> };
    let result = await ctx.call(`${prefix}final`, finalReq, analysisResultZ);
    // everything a reviewer reads must be Hebrew: an answer that explains in English is asked for once more
    if (englishExplanations(result).length) {
      log.info("ai answer in english, asking again in hebrew", { runId: run.id, texts: englishExplanations(result).length });
      result = await ctx.call(`${prefix}final-hebrew`, { ...finalReq, userText: finalText + HEBREW_AGAIN }, analysisResultZ);
    }
    mark(finalImages!, `${prefix}final`);
    inputRecord.images = inputRecord.images.map((i) => ({ ...i, sentIn: i.imageId ? sentIn.get(i.imageId) : undefined }));
    return { prepared, result, observations, inputRecord };
  };

  // a manuscript / handwritten letter / document gets the zoomed pages from the start; any other item that the model
  // recognises as handwriting gets ONE more pass with them (only then, so books do not pay for it)
  const manuscriptItem = ["MANUSCRIPT", "LETTER", "DOCUMENT"].includes(baseline.fields.itemType ?? "");
  let out = await pass(manuscriptItem, "");
  if (!manuscriptItem && cfg.BOOK_AI_MANUSCRIPT_ZOOM_PAGES > 0 && out.result.manuscriptAnalysis?.isManuscript) {
    log.info("ai: manuscript recognised, second pass with zoomed pages", { runId: run.id });
    try {
      out = await pass(true, "ms-");
    } catch (err) {
      if (!(err instanceof ProviderError || err instanceof InvalidAnswerError || err instanceof AppError)) throw err;
      log.warn("ai manuscript pass failed, keeping the first answer", { runId: run.id, err });
      out.result.warnings.push("סבב הקריאה המוגדלת של כתב היד נכשל. התוצאה מבוססת על הסבב הראשון, וייתכן שחלקים בכתב היד לא נקראו.");
    }
  }
  const { prepared, result, observations, inputRecord } = out;

  const extra = { base, inputRecord, imagesFingerprint: prepared.fingerprint, imageIds: new Set(prepared.images.map((i) => i.id)), startedAt, observations };
  if (run.isReanalysis) {
    await completeWithoutApplying(ctx, item.id, result, extra);
    return null;
  }
  return applyResult(ctx, item.id, result, extra);
}

/**
 * A re-analysis result is saved on the run and the item is left exactly as it is (fields, review status, approval, lot):
 * the reviewer compares it with the earlier result and applies it - all of it or chosen fields - explicitly.
 */
async function completeWithoutApplying(
  ctx: RunContext,
  itemId: string,
  result: AnalysisResult,
  extra: { inputRecord: object; startedAt: Date; observations: ObservationResult[] },
) {
  const { run } = ctx;
  const usage = ctx.usageColumns();
  await db.$transaction(async (tx) => {
    const mine = await tx.$queryRaw<{ status: string; startedAt: Date | null }[]>`SELECT status, "startedAt" FROM "InventoryAnalysis" WHERE id = ${run.id}::uuid FOR UPDATE`;
    if (mine[0]?.status !== "RUNNING" || mine[0].startedAt?.getTime() !== extra.startedAt.getTime()) throw new AppError("CONFLICT", "הניתוח נלקח על ידי תהליך אחר");
    const finishedAt = new Date();
    await tx.inventoryAnalysis.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        model: ctx.model ?? run.model,
        result: asJson(result),
        input: asJson(extra.inputRecord),
        ...omitPrice(usage),
        usage: asJson({ calls: ctx.calls, price: usage.price, observations: extra.observations.length ? extra.observations : undefined }),
        finishedAt,
        durationMs: finishedAt.getTime() - extra.startedAt.getTime(),
        error: null,
      },
    });
    // the button turns grey again (the run is the item's current one); aiCompletedAt, details, review state are untouched
    await tx.inventoryItem.updateMany({ where: { id: itemId, aiRunId: run.id }, data: { aiStatus: "COMPLETED", aiError: null } });
    await tx.auditLog.create({
      data: {
        organizationId: run.organizationId,
        userId: run.createdById,
        action: "ai.completed",
        entityType: "inventory",
        entityId: itemId,
        inventoryItemId: itemId,
        data: asJson({ runId: run.id, provider: ctx.provider.name, model: ctx.model ?? run.model, compareOnly: true, costUsd: usage.costUsd?.toNumber() ?? null, by: "system" }),
      },
    });
  });
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

/* ───────────────────────── apply a saved result ───────────────────────── */

const APPLY_FIELDS = ["itemType", "title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "bibliographicNotes", "conditionNotes", "catalogHeadline", "catalogDescription"] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];

export const applyRunSchema = z.object({
  /** the fields to apply; omitted = every field the result proposes that differs from the item now */
  fields: z.array(z.enum(APPLY_FIELDS)).min(1).max(APPLY_FIELDS.length).optional(),
});

/** What a result proposes, cleaned exactly like everything the AI writes (extent is never written). */
export function proposedValues(result: AnalysisResult): Partial<Record<ApplyField, string>> {
  const out: Partial<Record<ApplyField, string>> = {};
  for (const f of AI_FIELD_NAMES) {
    if (f === "extent") continue;
    const r = result.fields[f];
    if (r.status !== "found" || !r.value) continue;
    const v = cleanAiText(f === "title" ? r.value : stripMeasurements(r.value), AI_MAX_LENGTH[f]);
    if (v) out[f as ApplyField] = v;
  }
  const headline = cleanAiText(stripImageIds(result.catalog.headline), AI_MAX_LENGTH.catalogHeadline);
  if (headline) out.catalogHeadline = headline;
  const description = cleanAiText(ensureParagraphs(stripMeasurements(stripImageIds(result.catalog.description))), AI_MAX_LENGTH.catalogDescription);
  if (description) out.catalogDescription = description;
  if (result.itemType.value !== "UNKNOWN") out.itemType = result.itemType.value;
  return out;
}

/**
 * The reviewer applies a saved result (a re-analysis kept for comparison) - all of it or the chosen fields. This is an
 * explicit human decision, so the chosen values are written as they are; the values replaced are kept in the run's
 * snapshot (restorable), the change is logged, the details version moves (a stale editor gets 409), the review state
 * goes back to "ממתין לבדיקה", and an open lot gets the text through the same lot rules as the first analysis.
 */
export async function applyRun(user: UserPrincipal, runId: string, input: z.infer<typeof applyRunSchema>) {
  const run = await db.inventoryAnalysis.findFirst({ where: { id: runId, organizationId: user.organizationId, kind: AI_KIND } });
  if (!run) throw notFound("הניתוח");
  if (run.status !== "COMPLETED" || !run.result) throw new AppError("CONFLICT", "הניתוח לא הסתיים בהצלחה");
  if (run.applied) throw new AppError("CONFLICT", "תוצאת הניתוח הזו כבר הוחלה על הפריט");
  const result = run.result as unknown as AnalysisResult;
  const proposed = proposedValues(result);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${run.inventoryItemId}::uuid FOR UPDATE`;
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: run.inventoryItemId } });
    if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI פעיל על הפריט. אפשר להחיל אחרי שיסתיים.");
    const current = aiValuesOf(item);
    const patch: Partial<AiValues> = {};
    for (const f of input.fields ?? APPLY_FIELDS) {
      const v = proposed[f];
      if (v === undefined) continue;
      if (f === "itemType") {
        if (v !== current.itemType) patch.itemType = v as AiValues["itemType"];
      } else if (!sameText(v, current[f])) patch[f] = v;
    }
    const written = Object.keys(patch) as AiWritable[];
    if (!written.length) throw new AppError("CONFLICT", "אין מה להחיל: הערכים בתוצאה זהים לערכים הנוכחיים של הפריט");

    const snapshot: Record<string, unknown> = { values: current, catalogDescriptionSource: item.catalogDescriptionSource, detailsVersion: item.detailsVersion };
    const catalogWritten = patch.catalogHeadline !== undefined || patch.catalogDescription !== undefined;
    await tx.inventoryItem.update({ where: { id: item.id }, data: { ...(patch as Prisma.InventoryItemUpdateInput), ...(catalogWritten ? { catalogDescriptionSource: "AI" as const } : {}), detailsVersion: { increment: 1 } } });
    const lot = await applyToLot(tx, item.id, current, patch, user.userId, snapshot);
    await changeStatus(tx, user, item.id, "REVIEW", "PENDING_REVIEW", { reason: "תוצאת ניתוח AI הוחלה על ידי בודק", refType: "ai", refId: run.id });
    const applied: AppliedReport = {
      written: patch as Partial<Record<AiWritable, string>>,
      decisions: {},
      review: reviewForApplied(result, written),
      warnings: result.warnings,
      lot,
      imagesChanged: false,
      appliedFrom: { byUserId: user.userId, at: new Date().toISOString(), requested: [...(input.fields ?? [])] },
    };
    await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { applied: asJson(applied), snapshot: asJson(snapshot) } });
    await audit(user, { action: "ai.applied", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, lotId: lot?.lotId ?? null, data: asJson({ runId: run.id, model: run.model, fields: written, replacedValues: Object.fromEntries(written.map((f) => [f, current[f]])), lotVersion: lot?.descriptionVersion ?? null }) }, tx);
    return { fields: written, lotVersion: lot?.descriptionVersion ?? null };
  });
}

/* ───────────────────────── compare two runs ───────────────────────── */

const COMPARE_FIELDS = [
  ["title", "שם הספר"],
  ["subtitle", "כותרת משנה"],
  ["author", "מחבר / יוצר"],
  ["printPlace", "מקום דפוס"],
  ["printYear", "שנת דפוס"],
  ["publisher", "מדפיס"],
  ["edition", "מהדורה"],
  ["bibliographicNotes", "פרטים ביבליוגרפיים"],
  ["conditionNotes", "מצב העותק"],
  ["itemType", "סוג הפריט"],
  ["catalogHeadline", "כותרת קטלוגית"],
  ["catalogDescription", "תיאור קטלוגי"],
] as const;

interface RunInputMeta {
  settings?: { version: number | null; provider: string; model: string; reasoning: string | null; instructionHash: string };
  baseline?: { hash: string; source: string; missing: string[] };
  contextHash?: string;
  inputFingerprint?: string;
  imagesFingerprint?: string;
}

/**
 * Two runs of the same item side by side: every field, the findings, the main feature, and - what makes a comparison
 * honest - whether the INPUT was the same (original data, photos, prompt, examples). Different input = the difference
 * cannot be put on the model alone, and the screen says so. Nothing here ranks the runs: an empty field may be the
 * more accurate answer, the reviewer decides.
 */
export async function compareRuns(user: UserPrincipal, itemId: string, aId: string, bId: string) {
  if (aId === bId) throw new AppError("VALIDATION", "יש לבחור שני ניתוחים שונים");
  const runs = await db.inventoryAnalysis.findMany({ where: { id: { in: [aId, bId] }, inventoryItemId: itemId, organizationId: user.organizationId, kind: AI_KIND } });
  const a = runs.find((r) => r.id === aId);
  const b = runs.find((r) => r.id === bId);
  if (!a || !b) throw notFound("הניתוח");
  for (const r of [a, b]) if (r.status !== "COMPLETED" || !r.result) throw new AppError("CONFLICT", "אפשר להשוות רק ניתוחים שהסתיימו בהצלחה");

  const names = new Map((await db.user.findMany({ where: { id: { in: [a.createdById, b.createdById].filter((x): x is string => !!x) }, organizationId: user.organizationId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const view = (r: InventoryAnalysis) => {
    const result = r.result as unknown as AnalysisResult;
    const meta = (r.input ?? {}) as RunInputMeta;
    const proposed = proposedValues(result);
    const cell = (key: (typeof COMPARE_FIELDS)[number][0]) => {
      if (key === "itemType") return { value: result.itemType.value === "UNKNOWN" ? null : (he.itemType[result.itemType.value] ?? result.itemType.value), status: "found", confidence: result.itemType.confidence as string | null };
      if (key === "catalogHeadline" || key === "catalogDescription") return { value: proposed[key] ?? null, status: proposed[key] ? "found" : "unknown", confidence: result.catalog.confidence as string | null };
      const f = result.fields[key];
      return { value: proposed[key] ?? null, status: f.status as string, confidence: f.confidence as string | null };
    };
    return {
      meta: {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        provider: r.provider,
        model: r.model,
        reasoning: meta.settings?.reasoning ?? null,
        settingsVersion: r.settingsVersion,
        promptVersion: r.promptVersion,
        instructionHash: meta.settings?.instructionHash ?? null,
        examplesVersion: r.examplesVersion,
        examplesHash: r.examplesHash,
        baselineHash: meta.baseline?.hash ?? null,
        baselineSource: meta.baseline?.source ?? null,
        baselineMissing: meta.baseline?.missing ?? [],
        contextHash: meta.contextHash ?? null,
        imagesFingerprint: meta.imagesFingerprint ?? null,
        inputFingerprint: meta.inputFingerprint ?? null,
        costUsd: r.costUsd === null ? null : Number(r.costUsd),
        durationMs: r.durationMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        requestedBy: r.createdById ? (names.get(r.createdById) ?? null) : null,
        applied: r.applied !== null,
      },
      cells: Object.fromEntries(COMPARE_FIELDS.map(([k]) => [k, cell(k)])) as Record<string, { value: string | null; status: string; confidence: string | null }>,
      highlight: result.catalogHighlight ?? null,
      manuscript: result.manuscriptAnalysis ?? null,
      findings: result.findings.map((f) => `${f.kind}${f.transcription ? `: ${f.transcription}` : ""} (${f.reading})`),
      uncertain: result.requiresReview.map((x) => x.reason),
    };
  };
  const va = view(a);
  const vb = view(b);

  const rows = COMPARE_FIELDS.map(([key, label]) => {
    const x = va.cells[key]!;
    const y = vb.cells[key]!;
    const kind = !x.value && !y.value ? "bothEmpty" : x.value && !y.value ? "onlyA" : !x.value && y.value ? "onlyB" : sameText(x.value, y.value) ? "same" : "differs";
    return { key, label, a: x, b: y, kind };
  });
  const FIELD_ROWS = rows.filter((r) => r.key !== "catalogHeadline" && r.key !== "catalogDescription" && r.key !== "itemType");
  const countFound = (side: "a" | "b") => FIELD_ROWS.filter((r) => !!r[side].value).length;
  const aSet = new Set(va.findings);
  const bSet = new Set(vb.findings);

  const m1 = va.meta;
  const m2 = vb.meta;
  const unknown = (x: unknown) => x === null || x === undefined;
  const inputRows = [
    { key: "provider", label: "ספק", a: m1.provider, b: m2.provider, affectsComparability: false },
    { key: "model", label: "מודל", a: m1.model, b: m2.model, affectsComparability: false },
    { key: "reasoning", label: "רמת חשיבה", a: m1.reasoning, b: m2.reasoning, affectsComparability: false },
    { key: "promptVersion", label: "גרסת פרומפט", a: m1.promptVersion, b: m2.promptVersion, affectsComparability: true },
    { key: "instructionHash", label: "טביעת פרומפט", a: m1.instructionHash, b: m2.instructionHash, affectsComparability: true },
    { key: "examplesHash", label: "ספריית דוגמאות", a: m1.examplesHash ? `${m1.examplesVersion} (${m1.examplesHash})` : null, b: m2.examplesHash ? `${m2.examplesVersion} (${m2.examplesHash})` : null, affectsComparability: true },
    { key: "baselineHash", label: "נתוני המקור", a: m1.baselineHash, b: m2.baselineHash, affectsComparability: true },
    { key: "imagesFingerprint", label: "תמונות", a: m1.imagesFingerprint, b: m2.imagesFingerprint, affectsComparability: true },
    { key: "settingsVersion", label: "גרסת הגדרות", a: m1.settingsVersion, b: m2.settingsVersion, affectsComparability: false },
  ].map((r) => ({ ...r, a: r.a === null ? null : String(r.a), b: r.b === null ? null : String(r.b), same: r.a === r.b }));
  const differing = inputRows.filter((r) => r.affectsComparability && !r.same && !(unknown(r.a) && unknown(r.b)));
  const warnings: string[] = [];
  if (differing.length) warnings.push(`תנאי הקלט אינם זהים (${differing.map((r) => r.label).join(", ")}): אי אפשר לייחס את ההבדל בתוצאות להחלפת המודל בלבד.`);
  for (const [side, m] of [["הראשון", m1], ["השני", m2]] as const) {
    if (m.baselineMissing.length) warnings.push(`הניתוח ה${side} נבנה מנתוני מקור חלקיים (חסרים: ${m.baselineMissing.join(", ")}): ההשוואה אינה מבוססת על תמונת מצב מלאה.`);
    if (!m.baselineHash) warnings.push(`הניתוח ה${side} בוצע לפני שנשמרו נתוני המקור: לא ידוע מה נשלח למודל.`);
  }
  return {
    a: va,
    b: vb,
    rows,
    inputRows,
    comparable: differing.length === 0 && !warnings.length,
    warnings,
    summary: {
      foundA: countFound("a"),
      foundB: countFound("b"),
      onlyA: FIELD_ROWS.filter((r) => r.kind === "onlyA").map((r) => r.label),
      onlyB: FIELD_ROWS.filter((r) => r.kind === "onlyB").map((r) => r.label),
      differ: FIELD_ROWS.filter((r) => r.kind === "differs").map((r) => r.label),
      findingsOnlyA: va.findings.filter((x) => !bSet.has(x)),
      findingsOnlyB: vb.findings.filter((x) => !aSet.has(x)),
    },
  };
}

/* ───────────────────────── rewrite ("הוספת מידע ושכתוב") ───────────────────────── */

export const REWRITE_KIND = "catalog_rewrite";
/** a rewrite takes seconds; one still RUNNING after this was interrupted */
const REWRITE_STALE_MS = 3 * 60 * 1000;

export const rewriteSchema = z.object({
  /** facts the reviewer adds or a correction (a signature they identified, a changed year, a defect) */
  additions: z.string().trim().max(4000).default(""),
  /** patch (default): a minimal change, only what was asked. full: an explicit, separate full rewrite. */
  mode: z.enum(["patch", "full"]).default("patch"),
});

/**
 * Two modes, two different requests:
 *  - patch (default): the model gets the saved fields and the reviewer's instruction and returns OPERATIONS (add /
 *    replace / delete); the server applies them to the saved text. Anything not named is returned byte-identical -
 *    in fact not returned at all. An operation that cannot be verified against the current text is skipped and listed.
 *  - full: an explicit rewrite of every text field from the details and additions.
 * Neither writes anything to the item: the answer is returned and the panel applies it (with undo). Each rewrite is a
 * run of its own (cost, model, versions) and is logged. If the details change while the model works, the answer is
 * refused (409): it was built on text that no longer exists.
 */
export async function rewriteCatalog(user: UserPrincipal, itemId: string, input: z.infer<typeof rewriteSchema>) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId } });
  if (!item) throw notFound("הספר");
  if (input.mode === "patch" && !input.additions) throw new AppError("VALIDATION", "יש לכתוב את המידע להוספה או את התיקון המבוקש");
  const settings = await getAiSettings(user.organizationId);
  const provider = activeProvider(settings.cfg);
  if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI פעיל על הפריט. נסו לשכתב בסיומו.");
  const cfg = settings.cfg;
  const lib = settings.lib;
  const startedAt = new Date();
  // a rewrite left RUNNING (server restarted mid-request) would block the item: it is abandoned after a few minutes
  await db.inventoryAnalysis.updateMany({
    where: { inventoryItemId: itemId, kind: REWRITE_KIND, status: "RUNNING", updatedAt: { lt: new Date(Date.now() - REWRITE_STALE_MS) } },
    data: { status: "FAILED", error: "השכתוב הופסק (הפעלה מחדש של השרת)", finishedAt: new Date() },
  });
  const rewritePrompt = input.mode === "patch" ? settings.rewritePrompt : settings.fullRewritePrompt;
  const defaultPrompt = input.mode === "patch" ? settings.stored.rewritePrompt === null : settings.stored.fullRewritePrompt === null;
  const promptHash = createHash("sha256").update(rewritePrompt).digest("hex").slice(0, 12);
  let run: InventoryAnalysis;
  try {
    run = await db.inventoryAnalysis.create({
      data: {
        organizationId: user.organizationId,
        inventoryItemId: itemId,
        kind: REWRITE_KIND,
        status: "RUNNING",
        provider: provider.provider,
        model: provider.model,
        settingsVersion: settings.version,
        promptVersion: defaultPrompt ? `${REWRITE_PROMPT_VERSION}-${input.mode}` : `custom-${promptHash}`,
        examplesVersion: lib.version,
        examplesHash: lib.hash,
        examplesCount: lib.examples.length,
        requestKey: randomUUID(),
        createdById: user.userId,
        startedAt,
        input: asJson({ mode: input.mode, additions: input.additions, detailsVersion: item.detailsVersion }),
      },
    });
  } catch (err) {
    // one active run per item (an analysis or another rewrite)
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new AppError("CONFLICT", "פעולת AI אחרת פעילה על הפריט. נסו שוב בעוד רגע.");
    throw err;
  }

  const ctx = new RunContext(run, null, cfg, providerForRun(cfg));
  const v = aiValuesOf(item);
  const current = Object.fromEntries(REWRITE_FIELDS.map((f) => [f, (v[f] as string | null) ?? null])) as FieldValues;
  const details: Record<string, string | null> = { itemType: v.itemType === "UNKNOWN" ? null : he.itemType[v.itemType], ...current };
  const userText = [
    "# שדות הפריט כרגע (נבדקו בידי אדם; null = ריק)",
    "```json",
    JSON.stringify(details, null, 2),
    "```",
    "",
    input.mode === "patch" ? "# ההוראה של הבודק (מידע להוספה או תיקון)" : "# פרטים שהבודק הוסיף",
    input.additions ? `"""\n${redactPersonal(input.additions)}\n"""` : "(אין - שפר את הניסוח בלבד)",
    "",
    HEBREW_ONLY,
  ].join("\n");
  const instructions = [rewritePrompt.trim(), CODE_RULES].join("\n\n");
  const req: ProviderRequest = {
    instructions: lib.block ? `${instructions}\n\n${lib.block}` : instructions,
    cacheKey: `avot-${promptHash}-${lib.hash}`,
    userText,
    images: [],
    schemaName: input.mode === "patch" ? "catalog_patch" : "catalog_rewrite",
    schema: (input.mode === "patch" ? REWRITE_PATCH_JSON_SCHEMA : REWRITE_JSON_SCHEMA) as unknown as Record<string, unknown>,
    maxOutputTokens: 8000,
    timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
  };
  try {
    let outcome: { fields: Partial<Record<RewriteField, string>>; applied?: PatchOutcome["applied"]; skipped?: PatchOutcome["skipped"] };
    if (input.mode === "patch") {
      let r = await ctx.call("patch", req, rewritePatchZ);
      if (r.ops.some((o) => isEnglishProse(o.content))) r = await ctx.call("patch-hebrew", { ...req, userText: userText + HEBREW_AGAIN }, rewritePatchZ);
      outcome = applyOps(current, r.ops);
    } else {
      let r = await ctx.call("rewrite", req, rewriteResultZ);
      if (REWRITE_FIELDS.some((f) => isEnglishProse(r[f]))) r = await ctx.call("rewrite-hebrew", { ...req, userText: userText + HEBREW_AGAIN }, rewriteResultZ);
      // cleaned like every AI text; only the fields that actually change are returned (a null never empties a field)
      const fields: Partial<Record<RewriteField, string>> = {};
      for (const f of REWRITE_FIELDS) {
        const raw = f === "catalogHeadline" || f === "catalogDescription" ? stripImageIds(r[f]) : r[f];
        const cleaned = f === "title" || f === "catalogHeadline" ? raw : stripMeasurements(raw);
        const value = cleanAiText(f === "catalogDescription" ? ensureParagraphs(cleaned) : cleaned, AI_MAX_LENGTH[f]);
        if (value && !sameText(value, current[f])) fields[f] = value;
      }
      outcome = { fields };
    }
    // the answer was built on the saved text: if a person (or another action) changed the details meanwhile, it is void
    const now = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { detailsVersion: true } });
    if (now.detailsVersion !== item.detailsVersion) throw new AppError("CONFLICT", "פרטי הפריט עודכנו בזמן השכתוב, ולכן התוצאה בוטלה. נסו שוב.");
    const usage = ctx.usageColumns();
    const costUsd = usage.costUsd === null ? null : Number(usage.costUsd);
    await db.inventoryAnalysis.update({
      where: { id: run.id },
      data: { status: "COMPLETED", result: asJson({ mode: input.mode, ...outcome }), finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), ...omitPrice(usage), usage: asJson({ calls: ctx.calls, price: usage.price }) },
    });
    await audit(user, { action: "ai.rewrite", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { runId: run.id, mode: input.mode, provider: provider.provider, model: provider.model, costUsd, additions: input.additions.length > 0, fields: Object.keys(outcome.fields) } });
    return { runId: run.id, mode: input.mode, fields: outcome.fields, applied: outcome.applied ?? [], skipped: outcome.skipped ?? [], detailsVersion: item.detailsVersion, costUsd };
  } catch (err) {
    const message = err instanceof AppError || err instanceof ProviderError || err instanceof InvalidAnswerError ? err.message : "שגיאה פנימית בשכתוב";
    log.warn("ai rewrite failed", { runId: run.id, itemId, err });
    const usage = ctx.usageColumns();
    await db.inventoryAnalysis.update({
      where: { id: run.id },
      data: { status: "FAILED", error: message.slice(0, 1000), finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), ...omitPrice(usage), usage: asJson({ calls: ctx.calls, price: usage.price }) },
    });
    throw new AppError("CONFLICT", `השכתוב נכשל: ${message}`);
  }
}
