import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type LotAiRun } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import { asJson } from "../json";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { he } from "@/i18n/he";
import { activeProvider } from "../ai/config";
import { getAiSettings } from "../ai/settings";
import { providerForRun } from "../ai/providers";
import { ProviderError, type ProviderRequest } from "../ai/providers/types";
import { CODE_RULES } from "../ai/catalog-prompt";
import { HEBREW_AGAIN } from "../ai/prompt-builder";
import { InvalidAnswerError, isEnglishProse, parseAnswer } from "../ai/schema";
import { computeCost, type UsageTotals } from "../ai/pricing";
import { cleanAiText } from "../ai/text";
import { LOT_AI_JSON_SCHEMA, LOT_AI_MAX_LENGTH, LOT_PROMPT, LOT_PROMPT_VERSION, buildLotUserText, lotAiResultZ, type LotAiResult, type LotBookInput } from "../ai/lot-prompt";
import { lotMembers } from "./lot-members";

/*
 * "יצירת תיאור משותף ב-AI": the shared catalog description of a combined lot. A mechanism of its own:
 *  - reads the books (details, existing descriptions, findings of their own analyses) and NEVER writes to a book: no
 *    field, no aiStatus, no baseline, no analysis row, no review data. Its history is the LotAiRun table;
 *  - uses only the organization's AI settings (provider / model / reasoning / style examples) - no choice in the request;
 *  - produces a PREVIEW. The lot's title and text change only when a person applies the run, and then through a new
 *    LotDescriptionVersion (source AI); an older version is never deleted;
 *  - a run knows the composition it was written for: if books were added or removed since, the text is stale and
 *    cannot be applied (it must be regenerated), and an applied text is flagged "needs an update".
 */

const RUN_STALE_MS = 4 * 60 * 1000;
const PROVIDER_ATTEMPTS = 3;

async function loadLot(user: UserPrincipal, lotId: string) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  return lot;
}

/** The structured input for each book of the lot, in the lot's order (read only). */
export async function buildLotInput(lotId: string) {
  const members = await lotMembers(lotId);
  const ids = members.map((m) => m.inventoryItemId);
  const items = await db.inventoryItem.findMany({ where: { id: { in: ids } } });
  const runs = await db.inventoryAnalysis.findMany({ where: { inventoryItemId: { in: ids }, kind: "catalog_ai", status: "COMPLETED" }, orderBy: { createdAt: "desc" }, select: { inventoryItemId: true, result: true } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const books: LotBookInput[] = [];
  const snapshot: { itemId: string; bookId: string; inventoryNumber: string; sortOrder: number; detailsVersion: number; reviewStatus: string }[] = [];
  for (const [idx, m] of members.entries()) {
    const i = byId.get(m.inventoryItemId)!;
    const bookId = `book-${idx + 1}`;
    const verified = i.reviewStatus === "APPROVED";
    const latest = runs.find((r) => r.inventoryItemId === i.id)?.result as { findings?: { kind: string; transcription: string | null; reading: string; attribution: string | null; significance: string | null }[] } | null | undefined;
    books.push({
      bookId,
      verified,
      itemType: i.itemType === "UNKNOWN" ? null : (he.itemType[i.itemType] ?? null),
      title: i.title,
      subtitle: i.subtitle,
      author: i.author,
      printPlace: i.printPlace,
      printYear: i.printYear,
      publisher: i.publisher,
      edition: i.edition,
      extent: i.extent,
      bibliographicNotes: i.bibliographicNotes,
      conditionNotes: i.conditionNotes,
      existingHeadline: i.catalogHeadline,
      existingDescription: i.catalogDescription,
      findings: (latest?.findings ?? []).map((f) => ({ kind: f.kind, transcription: f.transcription ?? null, reading: f.reading, attribution: f.attribution ?? null, significance: f.significance ?? null })),
      photographerNotes: i.photographerNotes,
    });
    snapshot.push({ itemId: i.id, bookId, inventoryNumber: i.inventoryNumber, sortOrder: m.sortOrder, detailsVersion: i.detailsVersion, reviewStatus: i.reviewStatus });
  }
  return { books, snapshot };
}

export type LotAiRunSummary = ReturnType<typeof summarize>;

function summarize(r: LotAiRun, lotCompositionVersion: number, names: Map<string, string>) {
  const members = r.members as { itemId: string; inventoryNumber: string; sortOrder: number; detailsVersion: number; reviewStatus: string }[];
  const result = r.result as LotAiResult | null;
  return {
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdBy: r.createdById ? (names.get(r.createdById) ?? null) : null,
    provider: r.provider,
    model: r.model,
    settingsVersion: r.settingsVersion,
    promptVersion: r.promptVersion,
    examplesVersion: r.examplesVersion,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    costEstimated: r.costEstimated,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    error: r.error,
    proposedTitle: r.proposedTitle,
    proposedShortDescription: r.proposedShortDescription,
    proposedDescription: r.proposedDescription,
    warnings: result?.warnings ?? [],
    mainFeature: result?.mainFeature ?? null,
    sharedSignificance: result?.sharedSignificance ?? null,
    unverifiedInfoUsed: result?.unverifiedInfoUsed ?? false,
    compositionVersion: r.compositionVersion,
    /** the lot's books changed since this run: its text no longer fits the lot */
    stale: r.compositionVersion !== lotCompositionVersion,
    members,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    appliedVersion: r.appliedVersion,
    discardedAt: r.discardedAt?.toISOString() ?? null,
  };
}

/** What the lot page shows about the shared description: runs, whether the text needs an update, whether AI is available. */
export async function getLotAiState(user: UserPrincipal, lotId: string) {
  const lot = await loadLot(user, lotId);
  const runs = await db.lotAiRun.findMany({ where: { lotId }, orderBy: { createdAt: "desc" }, take: 15 });
  const userIds = [...new Set(runs.map((r) => r.createdById).filter((x): x is string => !!x))];
  const names = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const applied = lot.aiDescriptionRunId ? runs.find((r) => r.id === lot.aiDescriptionRunId) ?? (await db.lotAiRun.findUnique({ where: { id: lot.aiDescriptionRunId } })) : null;
  let available = true;
  let settings: { provider: string; model: string } | null = null;
  try {
    const s = await getAiSettings(user.organizationId);
    const p = activeProvider(s.cfg);
    settings = { provider: p.provider, model: p.model };
  } catch {
    available = false;
  }
  const members = await lotMembers(lotId);
  const unapproved = members.filter((m) => m.item.reviewStatus !== "APPROVED").map((m) => ({ itemId: m.inventoryItemId, inventoryNumber: m.item.inventoryNumber, title: m.item.title }));
  return {
    unapproved,
    compositionVersion: lot.compositionVersion,
    descriptionNeedsUpdate: lot.descriptionNeedsUpdate,
    /** the applied AI text was written for another composition of books */
    appliedBasedOnOlderComposition: !!applied && applied.compositionVersion !== lot.compositionVersion,
    appliedRunId: lot.aiDescriptionRunId,
    available,
    settings,
    runs: runs.map((r) => summarize(r, lot.compositionVersion, names)),
  };
}

/* ───────────────────────── run ───────────────────────── */

class Totals {
  totals: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, extraReasoningTokens: 0 };
  reasoning = 0;
  requests = 0;
  reported = true;
  calls: { attempt: number; ok: boolean; ms: number; error?: string; requestId?: string | null }[] = [];
}

async function ask(t: Totals, provider: ReturnType<typeof providerForRun>, req: ProviderRequest): Promise<LotAiResult> {
  let invalidRepeats = 0;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const rec: Totals["calls"][number] = { attempt, ok: false, ms: 0 };
    t.calls.push(rec);
    t.requests++;
    try {
      const res = await provider.generate(req);
      rec.ms = Date.now() - started;
      rec.requestId = res.requestId;
      if (res.usage) {
        t.totals.inputTokens += res.usage.inputTokens;
        t.totals.cachedInputTokens += res.usage.cachedInputTokens;
        t.totals.outputTokens += res.usage.outputTokens;
        t.totals.extraReasoningTokens += res.usage.extraReasoningTokens;
        t.reasoning += res.usage.reasoningTokens;
      } else t.reported = false;
      const parsed = parseAnswer(res.text, lotAiResultZ);
      rec.ok = true;
      return parsed;
    } catch (err) {
      rec.ms = Date.now() - started;
      rec.error = err instanceof Error ? err.message.slice(0, 400) : String(err);
      if (err instanceof InvalidAnswerError && invalidRepeats < 1) {
        invalidRepeats++;
        continue;
      }
      if (err instanceof ProviderError && err.retryable && attempt < PROVIDER_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.min(err.opts.retryAfterMs ?? 3000 * 2 ** (attempt - 1), 30_000)));
        continue;
      }
      throw err;
    }
  }
}

/** Generates a proposal for the lot. Returns the saved run (status COMPLETED, FAILED is thrown as an error after being saved). */
export async function generateLotDescription(user: UserPrincipal, lotId: string) {
  const lot = await loadLot(user, lotId);
  if (lot.mergedIntoLotId) throw new AppError("CONFLICT", "הפריט אוחד ללוט אחר");
  if (lot.assignmentStatus !== "ACTIVE") throw new AppError("CONFLICT", "השיוך הסתיים - לא ניתן ליצור תיאור ללוט");
  const settings = await getAiSettings(user.organizationId);
  const provider = activeProvider(settings.cfg);
  const startedAt = new Date();

  // one run at a time per lot: a double click returns the conflict; a run left RUNNING by a restart is closed
  await db.lotAiRun.updateMany({ where: { lotId, status: "RUNNING", createdAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }, data: { status: "FAILED", error: "הריצה הופסקה (הפעלה מחדש של השרת)", finishedAt: new Date() } });
  const { input, snapshot, books, compositionVersion } = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${lotId}::uuid FOR UPDATE`;
    const fresh = await tx.lot.findUniqueOrThrow({ where: { id: lotId }, select: { compositionVersion: true } });
    const built = await buildLotInput(lotId);
    if (built.books.length < 2) throw new AppError("CONFLICT", "זה אינו לוט משולב - התיאור המשותף נועד ללוט של כמה ספרים");
    const pending = built.snapshot.filter((s) => s.reviewStatus !== "APPROVED");
    if (pending.length) throw new AppError("CONFLICT", `יצירת תיאור משותף אפשרית רק כשפרטי כל הספרים בלוט נבדקו ואושרו. ממתינים לאישור: ${pending.map((p) => p.inventoryNumber).join(", ")}`, { code: "BOOKS_NOT_APPROVED", pending: pending.map((p) => p.inventoryNumber) });
    if (await tx.lotAiRun.count({ where: { lotId, status: "RUNNING" } })) throw new AppError("CONFLICT", "יצירת תיאור כבר רצה עבור הלוט. המתינו לסיומה.");
    return { input: built.books, snapshot: built.snapshot, books: built.books, compositionVersion: fresh.compositionVersion };
  });

  const lib = settings.lib;
  const instructions = [LOT_PROMPT.trim(), CODE_RULES].join("\n\n");
  const promptHash = createHash("sha256").update(instructions).digest("hex").slice(0, 12);
  const userText = buildLotUserText(books);
  const run = await db.lotAiRun.create({
    data: {
      organizationId: user.organizationId,
      lotId,
      status: "RUNNING",
      compositionVersion,
      members: asJson(snapshot),
      input: asJson({ books: input.map((b) => ({ ...b, photographerNotes: b.photographerNotes ? "(נשלח)" : null })), bookCount: input.length }),
      provider: provider.provider,
      model: provider.model,
      settingsVersion: settings.version,
      promptVersion: `${LOT_PROMPT_VERSION}-${promptHash}`,
      examplesVersion: lib.version,
      examplesHash: lib.hash,
      createdById: user.userId,
    },
  });

  const t = new Totals();
  const req: ProviderRequest = {
    instructions: lib.block ? `${instructions}\n\n${lib.block}` : instructions,
    cacheKey: `avot-lot-${promptHash}-${lib.hash}`,
    userText,
    images: [],
    schemaName: "lot_description",
    schema: LOT_AI_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 8000,
    timeoutMs: settings.cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
  };
  const costColumns = () => {
    // calls with an unusable answer were still paid for
    const cost = computeCost(provider.model, t.totals.inputTokens + t.totals.outputTokens > 0 ? t.totals : null, { usageReported: t.reported });
    return {
      requestCount: t.requests,
      inputTokens: t.totals.inputTokens,
      cachedInputTokens: t.totals.cachedInputTokens,
      outputTokens: t.totals.outputTokens + t.totals.extraReasoningTokens,
      costUsd: cost.costUsd === null ? null : new Prisma.Decimal(cost.costUsd),
      costEstimated: cost.estimated,
      usage: asJson({ calls: t.calls, price: cost.price, reasoningTokens: t.reasoning }),
      durationMs: Date.now() - startedAt.getTime(),
      finishedAt: new Date(),
    };
  };
  try {
    const sp = providerForRun(settings.cfg);
    let result = await ask(t, sp, req);
    const englishy = (r: LotAiResult) => [r.title, r.description, r.shortDescription, ...r.warnings, r.sharedSignificance.note].some((x) => isEnglishProse(x));
    if (englishy(result)) result = await ask(t, sp, { ...req, userText: userText + HEBREW_AGAIN });
    const title = cleanAiText(result.title, LOT_AI_MAX_LENGTH.title);
    const description = cleanAiText(result.description, LOT_AI_MAX_LENGTH.description);
    if (!title || !description) throw new InvalidAnswerError("תשובת המודל חסרה כותרת או תיאור");
    // the group changed while the model worked: the answer was written for books that are no longer the lot
    const now = await db.lot.findUniqueOrThrow({ where: { id: lotId }, select: { compositionVersion: true } });
    if (now.compositionVersion !== compositionVersion) throw new AppError("CONFLICT", "הרכב הלוט השתנה בזמן יצירת התיאור, ולכן התוצאה בוטלה. הריצו שוב.");
    const saved = await db.lotAiRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        proposedTitle: title,
        proposedShortDescription: cleanAiText(result.shortDescription, LOT_AI_MAX_LENGTH.shortDescription),
        proposedDescription: description,
        result: asJson(result),
        ...costColumns(),
      },
    });
    await audit(user, { action: "lot.ai_generated", entityType: "lot", entityId: lotId, lotId, data: asJson({ runId: run.id, provider: provider.provider, model: provider.model, books: snapshot.length, costUsd: saved.costUsd === null ? null : Number(saved.costUsd) }) });
    return saved;
  } catch (err) {
    const message = err instanceof AppError || err instanceof ProviderError || err instanceof InvalidAnswerError ? err.message : "שגיאה פנימית ביצירת התיאור";
    log.warn("lot ai failed", { runId: run.id, lotId, err });
    await db.lotAiRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message.slice(0, 1000), ...costColumns() } });
    throw new AppError("CONFLICT", `יצירת התיאור המשותף נכשלה: ${message}`);
  }
}

/* ───────────────────────── apply / discard ───────────────────────── */

export const applyLotAiSchema = z.object({
  /** the preview can be edited before it is applied; omitted = the model's text */
  title: z.string().trim().min(1).max(LOT_AI_MAX_LENGTH.title).optional(),
  shortDescription: z.string().trim().max(LOT_AI_MAX_LENGTH.shortDescription).nullish(),
  description: z.string().trim().min(1).max(LOT_AI_MAX_LENGTH.description).optional(),
});

/**
 * Writes the proposal into the lot after the person approved the preview: only title / shortDescription / description
 * of the LOT, as a new LotDescriptionVersion with source AI. Refused when the lot's books changed since the run.
 */
export async function applyLotAiRun(user: UserPrincipal, runId: string, raw: z.input<typeof applyLotAiSchema> = {}) {
  const input = applyLotAiSchema.parse(raw);
  const run = await db.lotAiRun.findFirst({ where: { id: runId, organizationId: user.organizationId } });
  if (!run) throw notFound("הריצה");
  const lotHead = await loadLot(user, run.lotId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lot" WHERE id = ${run.lotId}::uuid FOR UPDATE`;
    const lot = await tx.lot.findUniqueOrThrow({ where: { id: run.lotId } });
    const r = await tx.lotAiRun.findUniqueOrThrow({ where: { id: runId } });
    if (r.status !== "COMPLETED") throw new AppError("CONFLICT", "הריצה לא הסתיימה בהצלחה");
    if (r.appliedAt) throw new AppError("CONFLICT", "התיאור מהריצה הזו כבר הוחל על הלוט");
    if (r.discardedAt) throw new AppError("CONFLICT", "הריצה הזו נדחתה");
    if (lot.compositionVersion !== r.compositionVersion) throw new AppError("CONFLICT", "הרכב הלוט השתנה מאז יצירת התיאור. התיאור מבוסס על הרכב קודם ולא יוחל - הריצו את היצירה מחדש.");
    if (lot.assignmentStatus !== "ACTIVE" || lot.commercialStatus !== "ASSIGNED" || lotHead.catalog.status === "ARCHIVED") throw new AppError("CONFLICT", "הלוט כבר הוצע / נמכר או שהקטלוג בארכיון - התיאור לא ישתנה");
    const title = input.title ? cleanAiText(input.title, LOT_AI_MAX_LENGTH.title)! : (r.proposedTitle ?? lot.title);
    const shortDescription = input.shortDescription === undefined ? r.proposedShortDescription : cleanAiText(input.shortDescription, LOT_AI_MAX_LENGTH.shortDescription);
    const description = input.description ? cleanAiText(input.description, LOT_AI_MAX_LENGTH.description)! : r.proposedDescription;
    const u = await tx.lot.update({ where: { id: lot.id }, data: { title, shortDescription, description, descriptionNeedsUpdate: false, aiDescriptionRunId: r.id } });
    const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId: lot.id }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const edited = (input.title && input.title !== r.proposedTitle) || (input.description && input.description !== r.proposedDescription);
    await tx.lotDescriptionVersion.create({ data: { lotId: lot.id, version, title: u.title, shortDescription: u.shortDescription, description: u.description, source: edited ? "MANUAL" : "AI", createdById: user.userId } });
    await tx.lotAiRun.update({ where: { id: r.id }, data: { appliedAt: new Date(), appliedById: user.userId, appliedVersion: version } });
    await audit(user, { action: "lot.ai_applied", entityType: "lot", entityId: lot.id, lotId: lot.id, data: asJson({ runId: r.id, version, editedByPerson: !!edited }) }, tx);
    return { lotId: lot.id, version, title: u.title };
  });
}

/** The person rejects a proposal: it stays in the history, the lot is untouched. */
export async function discardLotAiRun(user: UserPrincipal, runId: string) {
  const run = await db.lotAiRun.findFirst({ where: { id: runId, organizationId: user.organizationId } });
  if (!run) throw notFound("הריצה");
  await loadLot(user, run.lotId);
  if (run.appliedAt) throw new AppError("CONFLICT", "התיאור כבר הוחל על הלוט");
  await db.lotAiRun.update({ where: { id: runId }, data: { discardedAt: new Date() } });
  await audit(user, { action: "lot.ai_discarded", entityType: "lot", entityId: run.lotId, lotId: run.lotId, data: asJson({ runId }) });
}

/** Clears the "needs an update" flag by a person's decision (the text is still right). */
export async function dismissNeedsUpdate(user: UserPrincipal, lotId: string) {
  await loadLot(user, lotId);
  await db.lot.update({ where: { id: lotId }, data: { descriptionNeedsUpdate: false } });
  await audit(user, { action: "lot.description_confirmed", entityType: "lot", entityId: lotId, lotId });
}


