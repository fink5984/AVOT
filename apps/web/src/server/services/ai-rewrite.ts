import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type InventoryAnalysis, type InventoryItem, type Job } from "@prisma/client";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import { asJson } from "../json";
import type { UserPrincipal } from "../auth/principal";
import { he } from "@/i18n/he";
import { aiConfig, activeProvider } from "../ai/config";
import { getAiSettings } from "../ai/settings";
import { CODE_RULES, REWRITE_PROMPT_VERSION } from "../ai/catalog-prompt";
import { HEBREW_AGAIN, HEBREW_ONLY, redactPersonal } from "../ai/prompt-builder";
import { REWRITE_PATCH_JSON_SCHEMA, REWRITE_FIELDS, InvalidAnswerError, isEnglishProse, rewritePatchZ, type RewriteField, type RewritePatch } from "../ai/schema";
import { applyOps, type FieldValues, type PatchOutcome } from "../ai/patch";
import { providerForRun } from "../ai/providers";
import { ProviderError, type ProviderRequest } from "../ai/providers/types";
import { sameText } from "../ai/text";
import { addBoldPhrases, carryFormat, ITEM_FORMAT_FIELDS, readTextFormat, type Segment } from "@/lib/rich-text";
import { itemTextFormatSchema } from "@/lib/rich-text";
import { aiValuesOf, AiRunFailed, markFailed, omitPrice, REWRITE_KIND, RunContext } from "./ai-analysis";
import { getItemOrThrow, updateItem } from "./inventory";

/*
 * "הוספת מידע ותיקון ממוקד ב-AI" as a SERVER-SIDE background job (same Job + worker as the first analysis).
 *
 * Before: the request waited for the model and the page applied the answer, so leaving the page lost it, and two
 * people could start two rewrites. Now:
 *   request  - ONE transaction: the item row is locked, a QUEUED run (the user's instruction, the details version it
 *              starts from, model and prompt versions) + an AI_REWRITE job + item.aiStatus = QUEUED. The partial unique
 *              index on InventoryAnalysis(inventoryItemId) for QUEUED/RUNNING runs is the database-level guarantee that
 *              an item never has two active AI actions (an analysis, a re-analysis or an addition), from any account.
 *   job      - claims the run (a stale RUNNING run is taken over after a crash), asks the model for OPERATIONS, applies
 *              them to the SAVED text on the server and saves item + run + status in ONE transaction, only if the
 *              details are still at the version the model read. Bold / underline / color of untouched text is carried over.
 *   conflict - somebody saved the details while the model worked: nothing is overwritten; the answer is kept as a
 *              proposal on the run, and a person applies it later (the operations are re-verified against the then-current text).
 *   failure  - the run is FAILED with a message, the item goes back to its resting state, the lock is released.
 */

/** a RUNNING rewrite not touched for this long was interrupted (a rewrite takes seconds) */
const REWRITE_STALE_MS = 5 * 60 * 1000;

export const rewriteSchema = z.object({
  /** facts the reviewer adds or a correction (a signature they identified, a changed year, a defect) */
  additions: z.string().trim().max(4000).default(""),
  mode: z.enum(["patch"]).default("patch"),
  /** client key of this click (double click / retry → the same run) */
  requestKey: z.string().uuid().optional(),
});

const ACTIVE = ["QUEUED", "RUNNING"] as const;
const isActive = (s: string) => (ACTIVE as readonly string[]).includes(s);

/* ───────────────────────── request ───────────────────────── */

export async function requestRewrite(user: UserPrincipal, itemId: string, input: z.infer<typeof rewriteSchema>) {
  const requestKey = input.requestKey ?? randomUUID();
  const prior = await db.inventoryAnalysis.findUnique({ where: { organizationId_requestKey: { organizationId: user.organizationId, requestKey } } });
  if (prior) {
    if (prior.inventoryItemId !== itemId) throw new AppError("CONFLICT", "מפתח הבקשה כבר שימש לפריט אחר");
    return { runId: prior.id, existing: true };
  }
  const item = await getItemOrThrow(user.organizationId, itemId);
  if (item.deletionRequestedAt) throw new AppError("CONFLICT", "הספר ממתין למחיקה");
  if (!input.additions) throw new AppError("VALIDATION", "יש לכתוב את המידע להוספה או את התיקון המבוקש");
  const settings = await getAiSettings(user.organizationId);
  const provider = activeProvider(settings.cfg);
  if (isActive(item.aiStatus)) throw new AppError("CONFLICT", "פעולת AI כבר פעילה על הפריט. אפשר להוסיף מידע בסיומה.");
  const rewritePrompt = settings.rewritePrompt;
  const defaultPrompt = settings.stored.rewritePrompt === null;
  const promptHash = createHash("sha256").update(rewritePrompt).digest("hex").slice(0, 12);
  const inline = aiConfig().BOOK_AI_INLINE;
  try {
    const created = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
      const now = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { aiStatus: true, detailsVersion: true } });
      if (isActive(now.aiStatus)) throw new AppError("CONFLICT", "פעולת AI כבר פעילה על הפריט. אפשר להוסיף מידע בסיומה.");
      const run = await tx.inventoryAnalysis.create({
        data: {
          organizationId: user.organizationId,
          inventoryItemId: itemId,
          kind: REWRITE_KIND,
          status: "QUEUED",
          provider: provider.provider,
          model: provider.model,
          settingsVersion: settings.version,
          promptVersion: defaultPrompt ? `${REWRITE_PROMPT_VERSION}-${input.mode}` : `custom-${promptHash}`,
          examplesVersion: settings.lib.version,
          examplesHash: settings.lib.hash,
          examplesCount: settings.lib.examples.length,
          requestKey,
          createdById: user.userId,
          baseDetailsVersion: now.detailsVersion,
          input: asJson({ mode: input.mode, additions: input.additions, detailsVersion: now.detailsVersion }),
        },
      });
      const job = await tx.job.create({
        data: { organizationId: user.organizationId, type: "AI_REWRITE", payload: { analysisId: run.id, itemId }, createdById: user.userId, ...(inline ? { status: "RUNNING", lockedAt: new Date(), attempts: 1 } : {}) },
      });
      await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { jobId: job.id } });
      await tx.inventoryItem.update({ where: { id: itemId }, data: { aiStatus: "QUEUED", aiRunId: run.id, aiError: null } });
      await audit(user, { action: "ai.rewrite_requested", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { runId: run.id, provider: provider.provider, model: provider.model, settingsVersion: settings.version, baseDetailsVersion: now.detailsVersion, instruction: input.additions.slice(0, 500) } }, tx);
      return { run, job };
    });
    if (inline) void runInline(created.job);
    return { runId: created.run.id, existing: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const same = await db.inventoryAnalysis.findUnique({ where: { organizationId_requestKey: { organizationId: user.organizationId, requestKey } } });
      if (same) return { runId: same.id, existing: true };
      throw new AppError("CONFLICT", "פעולת AI כבר פעילה על הפריט. אפשר להוסיף מידע בסיומה.");
    }
    throw err;
  }
}

/** BOOK_AI_INLINE (a local server that must not use the shared worker): run it here and close the job as the worker would. */
async function runInline(job: Job) {
  let error: string | null = null;
  try {
    await runAiRewriteJob(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("inline ai rewrite failed", { jobId: job.id, err });
  }
  await db.job.update({ where: { id: job.id }, data: { status: error ? "FAILED" : "SUCCEEDED", finishedAt: new Date(), error } }).catch(() => undefined);
}

/* ───────────────────────── job ───────────────────────── */

/** Worker entry point for AI_REWRITE jobs. */
export async function runAiRewriteJob(job: Job) {
  const { analysisId } = job.payload as { analysisId: string };
  await runRewrite(analysisId, job);
}

/** The user who asked, as the principal the item update is attributed to (their name in the history; permissions are checked on request). */
async function principalOf(userId: string | null, organizationId: string): Promise<UserPrincipal> {
  const u = userId ? await db.user.findFirst({ where: { id: userId, organizationId }, include: { houseAccess: { select: { auctionHouseId: true } } } }) : null;
  if (!u) throw new AppError("NOT_FOUND", "המשתמש שהפעיל את הפעולה לא נמצא");
  return {
    kind: "user",
    sessionId: "ai-job",
    userId: u.id,
    organizationId: u.organizationId,
    name: u.name,
    email: u.email,
    role: u.role,
    extraPermissions: u.extraPermissions,
    houseIds: u.role === "ADMIN" || u.houseAccess.length === 0 ? null : u.houseAccess.map((h) => h.auctionHouseId),
  };
}

/** Where an item rests when no AI action is running (the analysis button's state). */
const restingStatus = (item: { aiCompletedAt: Date | null }) => (item.aiCompletedAt ? ("COMPLETED" as const) : ("NOT_RUN" as const));

const rewriteValues = (item: Pick<InventoryItem, (typeof REWRITE_FIELDS)[number]>) => Object.fromEntries(REWRITE_FIELDS.map((f) => [f, (item[f] as string | null) ?? null])) as FieldValues;

export async function runRewrite(analysisId: string, job: Job | null = null) {
  const startedAt = new Date();
  // claim: a QUEUED run, or a RUNNING one abandoned by a crashed worker. Anything else (finished, running elsewhere) → nothing to do,
  // which is also what keeps a result from being applied twice when a job is delivered again.
  const claimed = await db.inventoryAnalysis.updateMany({
    where: { id: analysisId, kind: REWRITE_KIND, OR: [{ status: "QUEUED" }, { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - REWRITE_STALE_MS) } }] },
    data: { status: "RUNNING", startedAt, updatedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
  await db.inventoryItem.updateMany({ where: { id: run.inventoryItemId, aiRunId: run.id }, data: { aiStatus: "RUNNING" } });
  let ctx: RunContext | null = null;
  try {
    if (job && job.attempts > 3) throw new AppError("INTERNAL", "הפעולה הופסקה שוב ושוב (הפעלה מחדש של השרת). נסו שוב.");
    // the model, reasoning and prompts the run STARTED with, whatever the tab says now
    const settings = await getAiSettings(run.organizationId, run.settingsVersion ?? null);
    ctx = new RunContext(run, job, settings.cfg, providerForRun(settings.cfg));
    const item = await db.inventoryItem.findFirst({ where: { id: run.inventoryItemId, organizationId: run.organizationId } });
    if (!item) throw new AppError("NOT_FOUND", "הפריט לא נמצא (נמחק?)");
    const input = (run.input ?? {}) as { mode?: "patch"; additions?: string };
    const additions = input.additions ?? "";
    const readVersion = item.detailsVersion;
    const current = rewriteValues(item);
    const v = aiValuesOf(item);
    const details: Record<string, string | null> = { itemType: v.itemType === "UNKNOWN" ? null : he.itemType[v.itemType], ...current };
    const userText = ["# שדות הפריט כרגע (נבדקו בידי אדם; null = ריק)", "```json", JSON.stringify(details, null, 2), "```", "", "# ההוראה של הבודק (מידע להוספה או תיקון)", `"""\n${redactPersonal(additions)}\n"""`, "", HEBREW_ONLY].join("\n");
    const rewritePrompt = settings.rewritePrompt;
    const promptHash = createHash("sha256").update(rewritePrompt).digest("hex").slice(0, 12);
    const lib = settings.lib;
    const instructions = [rewritePrompt.trim(), CODE_RULES].join("\n\n");
    const req: ProviderRequest = {
      instructions: lib.block ? `${instructions}\n\n${lib.block}` : instructions,
      cacheKey: `avot-${promptHash}-${lib.hash}`,
      userText,
      images: [],
      schemaName: "catalog_patch",
      schema: REWRITE_PATCH_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 8000,
      timeoutMs: settings.cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
    };
    let r: RewritePatch = await ctx.call("patch", req, rewritePatchZ);
    if (r.ops.some((o) => isEnglishProse(o.content))) r = await ctx.call("patch-hebrew", { ...req, userText: userText + HEBREW_AGAIN }, rewritePatchZ);
    const outcome = applyOps(current, r.ops);
    await finishRewrite(ctx, item, { readVersion, outcome, ops: r.ops, additions, startedAt });
    log.info("ai rewrite finished", { runId: run.id, itemId: run.inventoryItemId, ms: Date.now() - startedAt.getTime() });
  } catch (err) {
    // another worker took the run over (this one was presumed dead): its result stands, this one writes nothing and marks nothing
    if (err instanceof AppError && (err.details as { code?: string } | undefined)?.code === "TAKEN_OVER") {
      log.warn("ai rewrite taken over by another worker", { runId: run.id });
      return;
    }
    const message = err instanceof AppError || err instanceof ProviderError || err instanceof InvalidAnswerError ? err.message : "שגיאה פנימית בהוספת המידע";
    log.warn("ai rewrite failed", { runId: run.id, itemId: run.inventoryItemId, err });
    await markFailed(run, message, startedAt, ctx);
    throw new AiRunFailed(message);
  }
}

/** The new text of a formatted field after an edit: the formatting of what was not touched is kept, a new important fact may be bold. */
function formattedDescription(item: Pick<InventoryItem, "catalogDescription" | "textFormat">, next: string, ops: RewritePatch["ops"]): Segment[] {
  const old = item.catalogDescription ?? "";
  let segs = carryFormat(old, readTextFormat(item.textFormat, ITEM_FORMAT_FIELDS).catalogDescription, next);
  for (const o of ops) {
    if (o.field !== "catalogDescription" || !o.content || !o.boldPhrases?.length) continue;
    const content = o.content.trim();
    const at = next.indexOf(content);
    if (at < 0) continue;
    segs = addBoldPhrases(next, segs, o.boldPhrases.filter((p) => content.includes(p)), [at, at + content.length]);
  }
  return segs;
}

interface Applied {
  /** new value of every field that changed (the name is never among them: it is only proposed) */
  fields: Partial<Record<RewriteField, string>>;
  /** the values those fields had before */
  before: Partial<Record<RewriteField, string | null>>;
}

/** Splits the patch outcome into what is applied and the name proposal. */
function splitOutcome(item: InventoryItem, outcome: PatchOutcome): { applied: Applied; titleProposal: string | null } {
  const fields: Applied["fields"] = {};
  const before: Applied["before"] = {};
  for (const [k, v] of Object.entries(outcome.fields) as [RewriteField, string][]) {
    if (k === "title") continue;
    fields[k] = v;
    before[k] = (item[k] as string | null) ?? null;
  }
  return { applied: { fields, before }, titleProposal: outcome.fields.title ?? null };
}

/** item patch + formatting from an applied outcome */
function buildPatch(item: InventoryItem, applied: Applied, ops: RewritePatch["ops"]) {
  const patch: Record<string, string> = { ...applied.fields };
  const textFormat: z.infer<typeof itemTextFormatSchema> | undefined = applied.fields.catalogDescription !== undefined ? { catalogDescription: formattedDescription(item, applied.fields.catalogDescription, ops) } : undefined;
  return { patch, textFormat };
}

async function finishRewrite(ctx: RunContext, item: InventoryItem, a: { readVersion: number; outcome: PatchOutcome; ops: RewritePatch["ops"]; additions: string; startedAt: Date }) {
  const { run } = ctx;
  const { applied, titleProposal } = splitOutcome(item, a.outcome);
  const usage = ctx.usageColumns();
  const base = {
    mode: "patch",
    ops: a.ops,
    fields: applied.fields,
    baseValues: applied.before,
    titleProposal,
    appliedOps: a.outcome.applied,
    skipped: a.outcome.skipped,
    baseVersion: a.readVersion,
  };
  const usageData = { ...omitPrice(usage), usage: asJson({ calls: ctx.calls, price: usage.price }), durationMs: Date.now() - a.startedAt.getTime(), finishedAt: new Date() };

  /** the claim check: only the claimant that started last may write (a worker presumed dead may come back) */
  const stillMine = async (tx: Tx) => {
    const mine = await tx.$queryRaw<{ status: string; startedAt: Date | null }[]>`SELECT status, "startedAt" FROM "InventoryAnalysis" WHERE id = ${run.id}::uuid FOR UPDATE`;
    if (mine[0]?.status !== "RUNNING" || mine[0].startedAt?.getTime() !== a.startedAt.getTime()) throw new AppError("CONFLICT", "הפעולה נלקחה על ידי תהליך אחר", { code: "TAKEN_OVER" });
  };
  const release = (tx: Tx, aiCompletedAt: Date | null) => tx.inventoryItem.updateMany({ where: { id: item.id, aiRunId: run.id }, data: { aiStatus: restingStatus({ aiCompletedAt }), aiError: null } });

  // nothing to write (the model found nothing to change, or every operation was unverifiable): the run ends, the item is untouched
  if (!Object.keys(applied.fields).length) {
    await db.$transaction(async (tx) => {
      await stillMine(tx);
      await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { status: "COMPLETED", model: ctx.model ?? run.model, result: asJson({ ...base, outcome: "no_change" }), error: null, ...usageData } });
      const now = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, select: { aiCompletedAt: true } });
      await release(tx, now.aiCompletedAt);
      await audit(await principalOf(run.createdById, run.organizationId), { action: "ai.rewrite_applied", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { runId: run.id, fields: [], skipped: a.outcome.skipped.length, titleProposed: !!titleProposal } }, tx);
    });
    return;
  }

  const requester = await principalOf(run.createdById, run.organizationId);
  const { patch, textFormat } = buildPatch(item, applied, a.ops);
  try {
    await updateItem(requester, item.id, { ...patch, ...(textFormat ? { textFormat } : {}) } as Parameters<typeof updateItem>[2], {
      expectedVersion: a.readVersion,
      source: "ai",
      // the item update, the run and the item's state move together or not at all
      inTx: async (tx, updated) => {
        await stillMine(tx);
        await tx.inventoryAnalysis.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            model: ctx.model ?? run.model,
            result: asJson({ ...base, outcome: "applied", appliedVersion: updated.detailsVersion }),
            applied: asJson({ fields: applied.fields, version: updated.detailsVersion }),
            snapshot: asJson({ values: applied.before, textFormat: item.textFormat ?? null, detailsVersion: a.readVersion }),
            error: null,
            ...usageData,
          },
        });
        await release(tx, updated.aiCompletedAt);
        await audit(requester, { action: "ai.rewrite_applied", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { runId: run.id, fields: Object.keys(applied.fields), skipped: a.outcome.skipped.length, titleProposed: !!titleProposal, detailsVersion: updated.detailsVersion, costUsd: usage.costUsd?.toNumber() ?? null, by: "ai-job" } }, tx);
      },
    });
  } catch (err) {
    // somebody saved the details while the model worked: never overwrite them. The answer stays as a proposal.
    if (err instanceof AppError && (err.details as { code?: string } | undefined)?.code === "STALE_DETAILS") {
      const currentVersion = (err.details as { detailsVersion?: number }).detailsVersion ?? null;
      await db.$transaction(async (tx) => {
        await stillMine(tx);
        await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { status: "COMPLETED", model: ctx.model ?? run.model, result: asJson({ ...base, outcome: "conflict", conflict: { baseVersion: a.readVersion, currentVersion } }), error: null, ...usageData } });
        const now = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, select: { aiCompletedAt: true } });
        await release(tx, now.aiCompletedAt);
        await audit(requester, { action: "ai.rewrite_conflict", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { runId: run.id, baseVersion: a.readVersion, currentVersion, fields: Object.keys(applied.fields), by: "ai-job" } }, tx);
      });
      return;
    }
    throw err;
  }
}

/* ───────────────────────── apply a held-back proposal ───────────────────────── */

/**
 * A person applies the proposal an edit conflict left. The model's operations are verified again against the text as it
 * is NOW (an operation whose target or anchor no longer exists is skipped and reported), and the write is refused if
 * the details change again while it is being made.
 */
export async function applyRewriteProposal(user: UserPrincipal, runId: string) {
  const run = await db.inventoryAnalysis.findFirst({ where: { id: runId, organizationId: user.organizationId, kind: REWRITE_KIND } });
  if (!run) throw notFound("הפעולה");
  const result = (run.result ?? null) as { outcome?: string; ops?: RewritePatch["ops"] } | null;
  if (run.status !== "COMPLETED" || result?.outcome !== "conflict" || !result.ops) throw new AppError("CONFLICT", "אין הצעה ממתינה בפעולה זו");
  if (run.applied) throw new AppError("CONFLICT", "ההצעה כבר הוחלה");
  if (run.restoredAt) throw new AppError("CONFLICT", "ההצעה בוטלה");
  const item = await getItemOrThrow(user.organizationId, run.inventoryItemId);
  if (isActive(item.aiStatus)) throw new AppError("CONFLICT", "פעולת AI פעילה על הפריט. אפשר להחיל בסיומה.");
  const outcome = applyOps(rewriteValues(item), result.ops);
  const { applied } = splitOutcome(item, outcome);
  if (!Object.keys(applied.fields).length) {
    throw new AppError("CONFLICT", `ההצעה כבר אינה מתאימה לטקסט הנוכחי${outcome.skipped.length ? `: ${outcome.skipped.map((s) => s.reason).join("; ")}` : ""}. אפשר להוסיף את המידע מחדש.`);
  }
  const { patch, textFormat } = buildPatch(item, applied, result.ops);
  const updated = await updateItem(user, item.id, { ...patch, ...(textFormat ? { textFormat } : {}) } as Parameters<typeof updateItem>[2], {
    expectedVersion: item.detailsVersion,
    source: "ai",
    inTx: async (tx, u) => {
      await tx.inventoryAnalysis.update({
        where: { id: run.id },
        data: {
          applied: asJson({ fields: applied.fields, version: u.detailsVersion, appliedLater: { byUserId: user.userId, at: new Date().toISOString() } }),
          snapshot: asJson({ values: applied.before, textFormat: item.textFormat ?? null, detailsVersion: item.detailsVersion }),
        },
      });
      await audit(user, { action: "ai.rewrite_proposal_applied", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { runId: run.id, fields: Object.keys(applied.fields), skipped: outcome.skipped.length } }, tx);
    },
  });
  return { fields: Object.keys(applied.fields), skipped: outcome.skipped, detailsVersion: updated.detailsVersion };
}

/* ───────────────────────── undo an applied addition ───────────────────────── */

/**
 * Puts back the values an addition replaced, together with the formatting that belonged to them. A field a person
 * changed since is left as it is (and reported): an undo never overwrites a newer edit.
 */
export async function undoRewrite(user: UserPrincipal, runId: string) {
  const run = await db.inventoryAnalysis.findFirst({ where: { id: runId, organizationId: user.organizationId, kind: REWRITE_KIND } });
  if (!run) throw notFound("הפעולה");
  const appliedRec = run.applied as { fields?: Record<string, string> } | null;
  const snap = run.snapshot as { values?: Record<string, string | null>; textFormat?: Prisma.JsonValue | null } | null;
  if (run.status !== "COMPLETED" || !appliedRec?.fields || !snap?.values) throw new AppError("CONFLICT", "לפעולה זו אין מה לבטל");
  if (run.restoredAt) throw new AppError("CONFLICT", "הפעולה כבר בוטלה");
  const item = await getItemOrThrow(user.organizationId, run.inventoryItemId);
  if (isActive(item.aiStatus)) throw new AppError("CONFLICT", "פעולת AI פעילה על הפריט. אפשר לבטל בסיומה.");
  const patch: Record<string, string | null> = {};
  const kept: string[] = [];
  for (const [f, written] of Object.entries(appliedRec.fields)) {
    const nowValue = ((item as unknown as Record<string, string | null>)[f] ?? null) as string | null;
    if (sameText(nowValue, written)) patch[f] = snap.values[f] ?? null;
    else kept.push(f);
  }
  if (!Object.keys(patch).length) throw new AppError("CONFLICT", "השדות שונו מאז, ולכן אין מה לבטל בלי לדרוס עריכה חדשה");
  const input: Record<string, unknown> = { ...patch };
  if ("catalogDescription" in patch) {
    const old = readTextFormat(snap.textFormat ?? null, ITEM_FORMAT_FIELDS).catalogDescription;
    input.textFormat = old ? { catalogDescription: old } : null;
  }
  await updateItem(user, item.id, input as Parameters<typeof updateItem>[2], {
    expectedVersion: item.detailsVersion,
    source: "manual",
    inTx: async (tx) => {
      await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { restoredAt: new Date(), restoredById: user.userId } });
      await audit(user, { action: "ai.rewrite_undone", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { runId: run.id, fields: Object.keys(patch), keptBecauseChanged: kept } }, tx);
    },
  });
  return { fields: Object.keys(patch), kept };
}

export type { InventoryAnalysis };
