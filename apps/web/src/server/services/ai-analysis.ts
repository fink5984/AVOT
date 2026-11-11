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
import { ANALYSIS_JSON_SCHEMA, analysisResultZ, englishExplanations, InvalidAnswerError, isEnglishProse, AI_FIELD_NAMES, OBSERVATION_JSON_SCHEMA, observationResultZ, parseAnswer, type AnalysisResult, type ObservationResult } from "../ai/schema";
import { estimateTokens, loadStyleLibrary } from "../ai/style-examples";
import { computeCost, type UsageTotals } from "../ai/pricing";
import { providerForRun, type AiProvider } from "../ai/providers";
import { ProviderError, type ProviderRequest, type ProviderResponse } from "../ai/providers/types";
import { cleanAiText, sameText } from "../ai/text";
import { identificationFrom, runResearch } from "../ai/research";
import { RESEARCH_WRITE_JSON_SCHEMA, RESEARCH_WRITE_RULES, researchBlock, researchWriteZ, vetClaims, type ResearchRecord } from "../ai/research-core";
import { boldSegments, ITEM_FORMAT_FIELDS, plainText, readTextFormat, type Segment } from "@/lib/rich-text";

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
/** "הוספת מידע ותיקון ממוקד": a background run of its own (see services/ai-rewrite.ts) */
export const REWRITE_KIND = "catalog_rewrite";
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
  /** external research of the run: not done / what happened, how many sources, what it cost (USD, an estimate) */
  research: { status: ResearchRecord["status"]; sources: number; costUsd: number | null } | null;
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
    research: r.research ? { status: (r.research as unknown as ResearchRecord).status, sources: (r.research as unknown as ResearchRecord).sources?.length ?? 0, costUsd: (r.research as unknown as ResearchRecord).costUsd ?? null } : null,
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
  const rewriteRuns = await db.inventoryAnalysis.findMany({ where: { inventoryItemId: itemId, kind: REWRITE_KIND }, orderBy: { createdAt: "desc" }, take: 10 });
  const activeRun = item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING" ? (item.aiRunId ? await db.inventoryAnalysis.findUnique({ where: { id: item.aiRunId } }) : null) : null;
  const rewriterIds = [...new Set([...rewriteRuns.map((r) => r.createdById), activeRun?.createdById].filter((x): x is string => !!x))].filter((x) => !names.has(x));
  if (rewriterIds.length) for (const u of await db.user.findMany({ where: { id: { in: rewriterIds }, organizationId: user.organizationId }, select: { id: true, name: true } })) names.set(u.id, u.name);
  return {
    /** what is running on the item now (same for every user): who started it and what it is */
    activity: activeRun
      ? {
          runId: activeRun.id,
          kind: (activeRun.kind === REWRITE_KIND ? "rewrite" : activeRun.isReanalysis ? "reanalysis" : "analysis") as "rewrite" | "reanalysis" | "analysis",
          status: activeRun.status,
          requestedBy: activeRun.createdById ? (names.get(activeRun.createdById) ?? null) : null,
          requestedById: activeRun.createdById,
          since: (activeRun.startedAt ?? activeRun.createdAt).toISOString(),
          instruction: activeRun.kind === REWRITE_KIND ? (((activeRun.input as { additions?: string } | null)?.additions ?? "").slice(0, 200) || null) : null,
        }
      : null,
    /** the last targeted additions ("הוספת מידע"): outcome, a proposal left by an edit conflict, what can be undone */
    rewrites: rewriteRuns.map((r) => {
      const res = (r.result ?? null) as { outcome?: string; fields?: Record<string, string>; skipped?: { field: string; reason: string }[]; titleProposal?: string | null; conflict?: { baseVersion: number; currentVersion: number } } | null;
      return {
        id: r.id,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        requestedBy: r.createdById ? (names.get(r.createdById) ?? null) : null,
        additions: ((r.input as { additions?: string } | null)?.additions ?? "").slice(0, 400),
        outcome: (res?.outcome ?? null) as "applied" | "conflict" | "no_change" | null,
        fields: Object.keys(res?.fields ?? {}),
        skipped: res?.skipped ?? [],
        titleProposal: res?.titleProposal ?? null,
        error: r.error,
        model: r.model,
        costUsd: r.costUsd === null ? null : Number(r.costUsd),
        undone: r.restoredAt !== null,
        /** an applied rewrite whose values can still be put back */
        undoable: res?.outcome === "applied" && r.restoredAt === null && r.status === "COMPLETED",
        /** a result held back because the details changed meanwhile: a person may still apply it */
        proposalPending: res?.outcome === "conflict" && r.applied === null && r.restoredAt === null && r.status === "COMPLETED",
      };
    }),
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
          /** the external research of that run (sources, links, what was learned, limits, cost), or null for a run made before research existed */
          research: (latest.research ?? null) as unknown as ResearchRecord | null,
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
  /** re-analysis only: save the result for comparison instead of filling the item (no screen sends this; default = fill everything anew) */
  compareOnly: z.boolean().optional(),
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
          ...(isReanalysis && input.compareOnly ? { input: asJson({ compareOnly: true }) } : {}),
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
  /** automatic bold of the description: the phrases that were found in the saved text (and how many could not be placed) */
  bold?: { phrases: string[]; skipped: number };
  /** a result applied from a saved comparison (not at the end of its own run): who, when, which fields were asked for */
  appliedFrom?: { byUserId: string; at: string; requested: string[] };
}

export class RunContext {
  calls: CallRecord[] = [];
  /** external research of the run (stage C) and what its web searches + tokens cost */
  research: ResearchRecord | null = null;
  researchCostUsd = 0;
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
    const total = cost.costUsd === null ? (this.researchCostUsd > 0 ? this.researchCostUsd : null) : cost.costUsd + this.researchCostUsd;
    return {
      requestCount: this.calls.length,
      inputTokens: this.totals.inputTokens,
      cachedInputTokens: this.totals.cachedInputTokens,
      outputTokens: this.totals.outputTokens + this.totals.extraReasoningTokens,
      reasoningTokens: this.reasoningTokens,
      costUsd: total === null ? null : new Prisma.Decimal(Number(total.toFixed(6))),
      // web-search prices are list-price estimates
      costEstimated: cost.estimated || this.researchCostUsd > 0,
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

export async function markFailed(run: InventoryAnalysis, message: string, startedAt: Date, ctx: RunContext | null) {
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
        ...(ctx?.research ? { research: asJson(ctx.research) } : {}),
      },
    });
    // only the item's CURRENT run decides its state; its details are never touched on failure.
    // A failed targeted addition goes back to the item's resting state (the analysis button is not turned red by it).
    if (run.kind === REWRITE_KIND) {
      const rest = await tx.inventoryItem.findUnique({ where: { id: run.inventoryItemId }, select: { aiCompletedAt: true } });
      await tx.inventoryItem.updateMany({ where: { id: run.inventoryItemId, aiRunId: run.id }, data: { aiStatus: rest?.aiCompletedAt ? "COMPLETED" : "NOT_RUN", aiError: message.slice(0, 500) } });
    } else {
      await tx.inventoryItem.updateMany({ where: { id: run.inventoryItemId, aiRunId: run.id }, data: { aiStatus: "FAILED", aiError: message.slice(0, 500) } });
    }
    await tx.auditLog.create({
      data: { organizationId: run.organizationId, userId: run.createdById, action: "ai.failed", entityType: "inventory", entityId: run.inventoryItemId, inventoryItemId: run.inventoryItemId, data: { runId: run.id, error: message.slice(0, 300), by: "system" } },
    });
  });
}

/** The AI result is written by the system, not by a person: status events carry no user (the requester is on the run). */
const systemPrincipal = (organizationId: string): DevicePrincipal => ({ kind: "device", deviceId: "ai", organizationId, deviceName: "AI" });

export const omitPrice = <T extends { price: unknown }>(u: T): Omit<T, "price"> => {
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
  const compareOnly = (run.input as { compareOnly?: boolean } | null)?.compareOnly === true;
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
  const { prepared, observations, inputRecord } = out;
  // stages B-D: focused queries, external research (when enabled and available), then the writing step that uses it.
  // A research problem never stops the analysis: it is recorded and the photo-based result stands.
  const result = await researchStage(ctx, settings, { context, instructions, common, result: out.result });
  (inputRecord as Record<string, unknown>).research = { enabled: settings.research.enabled, status: ctx.research?.status ?? null, settings: settings.research };

  const extra = { base, inputRecord, imagesFingerprint: prepared.fingerprint, imageIds: new Set(prepared.images.map((i) => i.id)), startedAt, observations };
  if (run.isReanalysis && compareOnly) {
    await completeWithoutApplying(ctx, item.id, result, extra);
    return null;
  }
  return applyResult(ctx, item.id, result, extra);
}

/** The user text of the writing step after a research: the photo-based identification, the draft and the (untrusted) sources. */
function researchWriteText(context: ItemContext, result: AnalysisResult, record: ResearchRecord): string {
  const found = Object.fromEntries(Object.entries(result.fields).filter(([, v]) => v.status === "found" && v.value).map(([k, v]) => [k, v.value]));
  const lines = [
    "# נתוני הפריט המקוריים",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
    "",
    "# מה זוהה בתמונות (ראיה ראשונית)",
    "```json",
    JSON.stringify({ itemType: result.itemType.value, summary: result.identification.summary, fields: found, mainFeature: result.catalogHighlight?.status === "found" ? result.catalogHighlight.mainFeature : null, findings: result.findings.map((f) => ({ kind: f.kind, transcription: f.transcription, reading: f.reading, attribution: f.attribution })), manuscript: result.manuscriptAnalysis?.isManuscript ? { kind: result.manuscriptAnalysis.kind, attributionLevel: result.manuscriptAnalysis.attributionLevel } : null }, null, 2),
    "```",
    "",
    "# הטיוטה הנוכחית (לשיפור לאור המחקר)",
    `כותרת: ${result.catalog.headline ?? ""}`,
    "תיאור:",
    result.catalog.description ?? "",
    "",
    researchBlock(record),
    "",
    HEBREW_ONLY,
  ];
  return lines.join("\n");
}

async function researchStage(ctx: RunContext, settings: ResolvedAiSettings, a: { context: ItemContext; instructions: string; common: { cacheKey: string; maxOutputTokens: number; timeoutMs: number }; result: AnalysisResult }): Promise<AnalysisResult> {
  const { result } = a;
  await ctx.heartbeat();
  const run = await runResearch({ cfg: settings.cfg, settings: settings.research, identification: identificationFrom(result) });
  const record = run.record;
  ctx.research = record;
  ctx.researchCostUsd += record.costUsd ?? 0;
  if (record.searches > 0 || record.status === "failed") ctx.calls.push({ stage: "research", images: [], attempt: 1, ok: record.status !== "failed", ms: record.durationMs, error: record.status === "failed" ? (record.reason ?? undefined) : undefined, model: record.model ?? undefined, usage: run.usage ?? undefined });
  if (record.sources.length) {
    try {
      const req = {
        instructions: `${a.instructions}\n\n${RESEARCH_WRITE_RULES}`,
        cacheKey: `${a.common.cacheKey}-research`,
        userText: researchWriteText(a.context, result, record),
        images: [],
        schemaName: "catalog_after_research",
        schema: RESEARCH_WRITE_JSON_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: a.common.maxOutputTokens,
        timeoutMs: a.common.timeoutMs,
      };
      let w = await ctx.call("write-after-research", req, researchWriteZ);
      if (isEnglishProse(w.description)) w = await ctx.call("write-after-research-hebrew", { ...req, userText: req.userText + HEBREW_AGAIN }, researchWriteZ);
      if (w.description?.trim() && w.headline?.trim()) {
        result.catalog = { ...result.catalog, headline: w.headline, description: w.description, boldPhrases: w.boldPhrases };
        record.usedInWriting = true;
      }
      record.claims = vetClaims(w.claims, record.sources);
      for (const c of w.contradictions) if (c.trim() && !record.contradictions.includes(c.trim())) record.contradictions.push(c.trim().slice(0, 500));
      result.requiresReview.push(...w.requiresReview.slice(0, 6));
    } catch (err) {
      if (!(err instanceof ProviderError || err instanceof InvalidAnswerError || err instanceof AppError)) throw err;
      log.warn("ai writing after research failed, keeping the photo-based text", { runId: ctx.run.id, err });
      record.status = "partial";
      record.reason = `כתיבת התיאור לאחר המחקר נכשלה (${err.message.slice(0, 160)}). נשמר התיאור שנכתב מהתמונות.`;
    }
  }
  // what a person must look at: contradictions with the photos and details the research could not settle
  for (const c of record.contradictions) result.requiresReview.push({ field: "research", reason: `מחקר חיצוני סותר או מסייג את הזיהוי: ${c}` });
  for (const v of record.requiresVerification.slice(0, 4)) result.requiresReview.push({ field: "research", reason: `מחקר חיצוני - נדרש אימות אנושי: ${v}` });
  if (record.status === "failed" || (record.status === "skipped" && settings.research.enabled)) result.warnings.push(`המחקר החיצוני לא בוצע: ${record.reason ?? "סיבה לא ידועה"}`);
  return result;
}

/** The textFormat column after the AI wrote a new description: the bold of THIS text, or none (stale formatting is removed). */
function descriptionFormat(existing: unknown, segs: Segment[] | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const out = readTextFormat(existing, ITEM_FORMAT_FIELDS);
  if (segs) out.catalogDescription = segs;
  else delete out.catalogDescription;
  return Object.keys(out).length ? asJson(out) : Prisma.DbNull;
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
        ...(ctx.research ? { research: asJson(ctx.research) } : {}),
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
      const mapped = mapResult({ result, current, base: extra.base, previousAi, imageIds: extra.imageIds, catalogIsManual, overwrite: run.isReanalysis });
      if (imagesChanged) mapped.review.push({ field: "images", reason: "תמונות הפריט השתנו בזמן הניתוח (נוספו, נמחקו או עובדו מחדש). כדאי לבדוק את הפרטים מול התמונות העדכניות." });

      const snapshot: Record<string, unknown> = { values: current, catalogDescriptionSource: item.catalogDescriptionSource, detailsVersion: item.detailsVersion, textFormat: item.textFormat ?? null };
      const written = Object.fromEntries(Object.entries(mapped.patch).map(([k, v]) => [k, v])) as Partial<Record<AiWritable, string>>;
      const catalogWritten = mapped.patch.catalogHeadline !== undefined || mapped.patch.catalogDescription !== undefined;
      // the bold phrases are located in the EXACT text that is saved (never by offsets from the model); the text itself is never altered
      const bold = typeof mapped.patch.catalogDescription === "string" ? boldSegments(mapped.patch.catalogDescription, result.catalog.boldPhrases ?? []) : null;
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          ...(mapped.patch as Prisma.InventoryItemUpdateInput),
          ...(mapped.patch.catalogDescription !== undefined ? { textFormat: descriptionFormat(item.textFormat, bold?.segments ?? null) } : {}),
          ...(catalogWritten ? { catalogDescriptionSource: "AI" as const } : {}),
          detailsVersion: { increment: 1 },
          aiStatus: "COMPLETED",
          aiRunId: run.id,
          aiCompletedAt: new Date(),
          aiError: null,
        },
      });

      const lot = await applyToLot(tx, itemId, current, mapped.patch, run.createdById, snapshot, bold?.segments ?? null);
      await changeStatus(tx, systemPrincipal(run.organizationId), itemId, "REVIEW", "PENDING_REVIEW", {
        reason: run.isReanalysis ? "ניתוח AI חוזר הושלם" : "ניתוח AI הושלם",
        refType: "ai",
        refId: run.id,
      });

      const applied: AppliedReport = { written, decisions: mapped.decisions, review: mapped.review, warnings: [...mapped.warnings, ...result.warnings], lot, imagesChanged, ...(bold ? { bold: { phrases: bold.applied, skipped: bold.skipped.length } } : {}) };
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
          ...(ctx.research ? { research: asJson(ctx.research) } : {}),
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
async function applyToLot(tx: Tx, itemId: string, before: AiValues, patch: Partial<AiValues>, userId: string | null, snapshot: Record<string, unknown>, descriptionSegs: Segment[] | null = null): Promise<AppliedReport["lot"]> {
  const member = await tx.lotMember.findFirst({ where: { inventoryItemId: itemId, isActive: true, removedAt: null }, include: { lot: { include: { catalog: { select: { status: true, number: true } } } } } });
  const lot = member?.lot;
  if (!lot) return null;
  // a combined lot has its own shared description (its own AI run): one book's analysis never writes into it
  if ((await tx.lotMember.count({ where: { lotId: lot.id, removedAt: null } })) > 1) {
    return { lotId: lot.id, fields: [], descriptionVersion: null, skippedReason: `הספר נמצא בלוט משולב (פריט ${lot.lotNumber}); התיאור המשותף של הלוט לא שונה` };
  }
  if (!lotIsOpenForAi(lot)) return { lotId: lot.id, fields: [], descriptionVersion: null, skippedReason: `הפריט בקטלוג ${lot.catalog.number} כבר הוצע / נמכר או שהקטלוג בארכיון; התיאור שבקטלוג לא שונה` };
  snapshot.lot = { id: lot.id, title: lot.title, subtitle: lot.subtitle, author: lot.author, printYear: lot.printYear, printPlace: lot.printPlace, shortDescription: lot.shortDescription, description: lot.description, textFormat: lot.textFormat ?? null };
  const data: Record<string, string | null> = {};
  for (const f of LOT_COPY_FIELDS) {
    if (patch[f] !== undefined && sameText(lot[f], before[f])) data[f] = patch[f] as string;
  }
  if (patch.catalogHeadline !== undefined && (!lot.shortDescription?.trim() || sameText(lot.shortDescription, before.catalogHeadline))) data.shortDescription = cleanAiText(patch.catalogHeadline, 2000);
  if (patch.catalogDescription !== undefined && (!lot.description?.trim() || sameText(lot.description, before.catalogDescription))) data.description = cleanAiText(patch.catalogDescription, AI_MAX_LENGTH.catalogDescription);
  if (!Object.keys(data).length) return { lotId: lot.id, fields: [], descriptionVersion: null };
  // the lot's description carries the same bold as the book's, only while the formatting spells exactly the text saved on the lot
  const lotFormat = "description" in data ? (descriptionSegs && plainText(descriptionSegs) === data.description ? { description: descriptionSegs } : null) : undefined;
  const u = await tx.lot.update({ where: { id: lot.id }, data: { ...data, ...(lotFormat !== undefined ? { textFormat: lotFormat ? asJson(lotFormat) : Prisma.DbNull } : {}) } });
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
    const snap = run.snapshot as { values: AiValues; catalogDescriptionSource: InventoryItem["catalogDescriptionSource"]; textFormat?: Prisma.JsonValue | null; lot?: Record<string, string | null> & { id: string; textFormat?: Prisma.JsonValue | null } };
    const written = (run.applied as unknown as AppliedReport).written;
    const fields = Object.keys(written) as AiWritable[];
    const now = aiValuesOf(item);
    const data: Record<string, unknown> = {};
    for (const f of fields) data[f] = f === "title" ? (snap.values.title ?? item.title) : snap.values[f];
    const before = Object.fromEntries(fields.map((f) => [f, now[f]]));
    if (fields.some((f) => f === "catalogHeadline" || f === "catalogDescription")) data.catalogDescriptionSource = snap.catalogDescriptionSource;
    // the formatting that belonged to the restored text comes back with it (runs made before formatting was saved have no key: left as is)
    if (fields.includes("catalogDescription") && "textFormat" in snap) data.textFormat = snap.textFormat ?? Prisma.DbNull;
    await tx.inventoryItem.update({ where: { id: item.id }, data: { ...(data as Prisma.InventoryItemUpdateInput), detailsVersion: { increment: 1 } } });
    await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { restoredAt: new Date(), restoredById: user.userId } });

    let lotVersion: number | null = null;
    const appliedLot = (run.applied as unknown as AppliedReport).lot;
    if (snap.lot && appliedLot?.fields.length) {
      const lot = await tx.lot.findFirst({ where: { id: snap.lot.id, assignmentStatus: "ACTIVE" }, include: { catalog: { select: { status: true } } } });
      const combined = lot ? (await tx.lotMember.count({ where: { lotId: lot.id, removedAt: null } })) > 1 : false;
      if (lot && !combined && lotIsOpenForAi(lot)) {
        const lotData: Record<string, string | null> = {};
        for (const f of appliedLot.fields) {
          const aiValue = f === "shortDescription" ? written.catalogHeadline : f === "description" ? written.catalogDescription : written[f as AiWritable];
          if (sameText((lot as unknown as Record<string, string | null>)[f], aiValue ?? null)) lotData[f] = f === "title" ? (snap.lot[f] ?? lot.title) : snap.lot[f] ?? null;
        }
        if (Object.keys(lotData).length) {
          const u = await tx.lot.update({ where: { id: lot.id }, data: { ...lotData, ...("description" in lotData && "textFormat" in snap.lot ? { textFormat: snap.lot.textFormat ?? Prisma.DbNull } : {}) } });
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
  const open = await db.inventoryAnalysis.findMany({ where: { kind: { in: [AI_KIND, REWRITE_KIND] }, status: { in: ["QUEUED", "RUNNING"] }, updatedAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }, take: 50 });
  for (const r of open) {
    const job = r.jobId ? await db.job.findUnique({ where: { id: r.jobId }, select: { status: true } }) : null;
    if (job && (job.status === "QUEUED" || job.status === "RUNNING")) continue;
    await markFailed(r, r.kind === REWRITE_KIND ? "הוספת המידע לא הסתיימה (המשימה ברקע אבדה). אפשר לנסות שוב." : "הניתוח לא הסתיים (המשימה ברקע אבדה). אפשר לנסות שוב.", r.startedAt ?? r.createdAt, null);
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
      settingsVersion: r.settingsVersion ?? "",
      reasoning: (r.input as { settings?: { reasoning?: string | null } } | null)?.settings?.reasoning ?? "",
      baselineHash: (r.input as { baseline?: { hash?: string } } | null)?.baseline?.hash ?? "",
      inputFingerprint: (r.input as { inputFingerprint?: string } | null)?.inputFingerprint ?? "",
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

    const snapshot: Record<string, unknown> = { values: current, catalogDescriptionSource: item.catalogDescriptionSource, detailsVersion: item.detailsVersion, textFormat: item.textFormat ?? null };
    const catalogWritten = patch.catalogHeadline !== undefined || patch.catalogDescription !== undefined;
    const bold = typeof patch.catalogDescription === "string" ? boldSegments(patch.catalogDescription, result.catalog.boldPhrases ?? []) : null;
    await tx.inventoryItem.update({ where: { id: item.id }, data: { ...(patch as Prisma.InventoryItemUpdateInput), ...(patch.catalogDescription !== undefined ? { textFormat: descriptionFormat(item.textFormat, bold?.segments ?? null) } : {}), ...(catalogWritten ? { catalogDescriptionSource: "AI" as const } : {}), detailsVersion: { increment: 1 } } });
    const lot = await applyToLot(tx, item.id, current, patch, user.userId, snapshot, bold?.segments ?? null);
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

/**
 * The small state every open copy of an item page polls (a few cheap queries): is an AI action running, who started
 * it, and has the item's text changed (detailsVersion). When the numbers change the page reloads the full state.
 */
export async function getAiLite(user: UserPrincipal, itemId: string) {
  const item = await db.inventoryItem.findFirst({
    where: { id: itemId, organizationId: user.organizationId },
    select: { aiStatus: true, aiRunId: true, aiError: true, aiCompletedAt: true, detailsVersion: true, reviewStatus: true },
  });
  if (!item) throw notFound("הספר");
  const active = item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING";
  const run = active && item.aiRunId ? await db.inventoryAnalysis.findUnique({ where: { id: item.aiRunId }, select: { id: true, kind: true, status: true, isReanalysis: true, createdById: true, createdAt: true, startedAt: true } }) : null;
  const by = run?.createdById ? await db.user.findFirst({ where: { id: run.createdById, organizationId: user.organizationId }, select: { name: true } }) : null;
  return {
    aiStatus: item.aiStatus,
    aiError: item.aiError,
    hasSuccessfulAnalysis: item.aiCompletedAt !== null,
    detailsVersion: item.detailsVersion,
    reviewStatus: item.reviewStatus,
    activity: run
      ? { runId: run.id, kind: (run.kind === REWRITE_KIND ? "rewrite" : run.isReanalysis ? "reanalysis" : "analysis") as "rewrite" | "reanalysis" | "analysis", status: run.status, requestedBy: by?.name ?? null, requestedById: run.createdById, since: (run.startedAt ?? run.createdAt).toISOString() }
      : null,
  };
}
export type AiLite = Awaited<ReturnType<typeof getAiLite>>;
