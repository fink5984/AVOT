import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { hashPassword } from "@/server/auth/password";
import { storage } from "@/server/storage";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog } from "@/server/services/assignments";
import { listInventory, updateItem } from "@/server/services/inventory";
import { approveReview, startReview } from "@/server/services/item-review";
import { applyRun, compareRuns, getAiState, recoverOrphanRuns, requestAnalysis, restoreRun, rewriteCatalog, runAnalysis, listRunsForReport } from "@/server/services/ai-analysis";
import { Prisma } from "@prisma/client";
import { computeBaseline, confirmBaselineFromCurrent } from "@/server/ai/baseline";
import { restoreAiSettingsVersion, saveAiSettings } from "@/server/ai/settings";
import { setProviderOverride } from "@/server/ai/providers";
import { ProviderError, type AiProvider, type ProviderRequest, type ProviderResponse } from "@/server/ai/providers/types";
import { AI_FIELD_NAMES, type AnalysisResult } from "@/server/ai/schema";
import { hasForbiddenDash } from "@/server/ai/text";
import { createBook, hasDb, makeOrg } from "./helpers";

/* A fake provider: records every request and answers with a scripted result. No network call is ever made. */
class FakeProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly model = "gpt-5.4-mini";
  requests: ProviderRequest[] = [];
  answer: (req: ProviderRequest, n: number) => unknown | Promise<unknown> = () => goodResult();
  failWith: ProviderError | null = null;
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    if (this.failWith) throw this.failWith;
    const body = await this.answer(req, this.requests.length);
    return { text: typeof body === "string" ? body : JSON.stringify(body), usage: { inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 1200, reasoningTokens: 300, extraReasoningTokens: 0 }, model: "gpt-5.4-mini-2026-03-17", requestId: `req-${this.requests.length}`, finish: "completed" };
  }
}

const f = (value: string | null, over: Partial<AnalysisResult["fields"]["title"]> = {}) => ({
  status: (value ? "found" : "unknown") as "found" | "unknown",
  value,
  confidence: (value ? "high" : null) as "high" | null,
  source: (value ? "image" : null) as "image" | null,
  imageIds: value ? ["img-01"] : [],
  note: null,
  ...over,
});
function goodResult(over: Partial<AnalysisResult> = {}, fields: Partial<AnalysisResult["fields"]> = {}): AnalysisResult {
  return {
    itemType: { value: "BOOK", confidence: "high", note: null },
    identification: { summary: "ספר חובות הלבבות, זולקווא", existingTitleCheck: "more_precise_available", conflicts: [] },
    fields: {
      ...(Object.fromEntries(AI_FIELD_NAMES.map((k) => [k, f(null)])) as AnalysisResult["fields"]),
      title: f("ספר חובות הלבבות"),
      author: f("רבינו בחיי אבן פקודה"),
      printPlace: f("זולקווא"),
      printYear: f("תקנ\"ט [1799]", { confidence: "medium" }),
      conditionNotes: f("כתמים — בלאי. קרעים בשוליים."),
      ...fields,
    },
    catalog: { headline: "ספר חובות הלבבות — זולקווא", description: "ספר חובות הלבבות. זולקווא, תקנ\"ט [1799].\n\nכתמים – בלאי.", confidence: "medium" },
    findings: [{ kind: "signature", imageIds: ["img-01"], transcription: "שייך לה\"ה — יעקב", reading: "probable", attribution: null, attributionBasis: null, significance: null }],
    imagesReviewed: [{ imageId: "img-01", shows: "שער", usable: true }],
    requiresReview: [{ field: "printYear", reason: "השנה בפרט, החישוב לא ודאי" }],
    warnings: [],
    ...over,
  };
}

describe.skipIf(!hasDb)("AI analysis (real database, fake provider)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let other: Awaited<ReturnType<typeof makeOrg>>;
  const fake = new FakeProvider();
  const ADMIN_PASSWORD = "admin-password-123";
  const EDITOR_PASSWORD = "editor-password-123";
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "sk-it-not-used";
    process.env.BOOK_AI_PROVIDER = "openai";
    ctx = await makeOrg("ai");
    other = await makeOrg("ai-other");
    await db.user.update({ where: { id: ctx.admin.userId }, data: { passwordHash: await hashPassword(ADMIN_PASSWORD) } });
    await db.user.update({ where: { id: ctx.editor.userId }, data: { passwordHash: await hashPassword(EDITOR_PASSWORD) } });
    setProviderOverride(fake);
  });
  afterEach(() => {
    fake.requests = [];
    fake.failWith = null;
    fake.answer = () => goodResult();
    delete process.env.BOOK_AI_MAX_IMAGES_PER_REQUEST;
  });
  afterAll(() => {
    setProviderOverride(null);
    process.env = savedEnv;
  });

  async function addPhoto(itemId: string, category: "COVER" | "TITLE_PAGE" | "INTERIOR" | "EXTERIOR", seq: number, opts: { rotation?: number; missing?: boolean } = {}) {
    const key = `orgs/${ctx.org.id}/it-ai/${itemId}/${seq}.jpg`;
    const jpg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toBuffer();
    if (!opts.missing) await storage().putBuffer(key, jpg, "image/jpeg");
    return db.photoAsset.create({
      data: {
        organizationId: ctx.org.id,
        inventoryItemId: itemId,
        category,
        captureId: randomUUID(),
        source: "SIMULATOR",
        sequence: seq,
        sortOrder: seq,
        rotation: opts.rotation ?? 0,
        capturedAt: new Date(),
        files: { create: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: jpg.length, sha256: "0".repeat(64), storageKey: key, uploadStatus: "VERIFIED" }] },
      },
    });
  }

  /** request + run the job inline (the worker does exactly this) */
  async function analyse(user = ctx.photographer, itemId: string, approval?: { email: string; password: string }, compareOnly = false) {
    const r = await requestAnalysis(user, itemId, { requestKey: randomUUID(), approval, compareOnly });
    await runAnalysis(r.runId).catch(() => undefined);
    return db.inventoryAnalysis.findUniqueOrThrow({ where: { id: r.runId } });
  }

  it("permissions: photographers may start an analysis; only managers approve a re-analysis; review by editors", () => {
    expect(can("PHOTOGRAPHER", "ai.analyze")).toBe(true);
    expect(can("VIEWER", "ai.analyze")).toBe(false);
    expect(can("WAREHOUSE", "ai.analyze")).toBe(false);
    expect(can("ADMIN", "ai.reanalyze.approve")).toBe(true);
    for (const r of ["EDITOR", "PHOTOGRAPHER", "WAREHOUSE", "VIEWER"] as const) expect(can(r, "ai.reanalyze.approve")).toBe(false);
    expect(can("EDITOR", "item.review")).toBe(true);
    expect(can("PHOTOGRAPHER", "item.review")).toBe(false);
  });

  it("first run: fields filled, catalog draft saved, NOT_STARTED → PENDING_REVIEW, cost and audit recorded", async () => {
    const { item } = await createBook(ctx.photographer, { title: "ספר ישן מנחה" });
    expect(item.reviewStatus).toBe("NOT_STARTED");
    expect(item.aiStatus).toBe("NOT_RUN");
    await db.inventoryItem.update({ where: { id: item.id }, data: { photographerNotes: "חסר דף אחרון. טל' 050-1234567", internalNotes: "סודי: מחיר שמורה 500" } });
    await addPhoto(item.id, "COVER", 1);
    await addPhoto(item.id, "TITLE_PAGE", 2, { rotation: 90 });
    await addPhoto(item.id, "INTERIOR", 3);

    const run = await analyse(ctx.photographer, item.id);
    expect(run.status).toBe("COMPLETED");
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    // the name stays the person's: the AI's reading is a proposal
    expect(after).toMatchObject({ title: "ספר ישן מנחה", author: "רבינו בחיי אבן פקודה", printPlace: "זולקווא", itemType: "BOOK", aiStatus: "COMPLETED", reviewStatus: "PENDING_REVIEW", catalogDescriptionSource: "AI" });
    expect((run.applied as { decisions: Record<string, unknown> }).decisions.title).toMatchObject({ action: "kept", proposed: "ספר חובות הלבבות" });
    expect(after.aiCompletedAt).not.toBeNull();
    // the dash rule on everything written
    for (const v of [after.conditionNotes, after.catalogHeadline, after.catalogDescription]) expect(hasForbiddenDash(v ?? "")).toBe(false);
    expect(after.catalogHeadline).toBe("ספר חובות הלבבות - זולקווא");
    // protected data untouched
    expect(after).toMatchObject({ inventoryNumber: item.inventoryNumber, barcode: item.barcode, consignorId: item.consignorId, photographerNotes: "חסר דף אחרון. טל' 050-1234567", internalNotes: "סודי: מחיר שמורה 500" });

    // what was sent: images with ids (title page high detail + zooms), notes redacted, no internal notes / consignor
    const req = fake.requests[0]!;
    expect(req.images.map((i) => i.id)).toEqual(["img-01", "img-02", "img-02-top", "img-02-bottom", "img-03"]);
    expect(req.images.find((i) => i.id === "img-02")!.detail).toBe("high");
    expect(req.userText).toContain("[טלפון הוסר]");
    expect(req.userText).not.toContain("050-1234567");
    expect(req.userText).not.toContain("מחיר שמורה");
    expect(req.userText).not.toContain(item.inventoryNumber);
    expect(req.instructions).toContain("# דוגמאות כתיבה");
    // the rotated title page arrives rotated (portrait)
    const meta = await sharp(req.images[1]!.data).metadata();
    expect(meta.height!).toBeGreaterThan(meta.width!);

    // run record: versions, usage, cost, snapshot, evidence kept raw
    expect(run).toMatchObject({ provider: "openai", model: "gpt-5.4-mini-2026-03-17", imageCount: 3, requestCount: 1, inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 1200, costEstimated: false });
    expect(run.promptVersion).toMatch(/^avot-catalog-/);
    expect(run.examplesHash).toMatch(/^[0-9a-f]{16}$/);
    expect(Number(run.costUsd)).toBeCloseTo((1000 * 0.75 + 4000 * 0.075 + 1200 * 4.5) / 1e6, 6);
    expect((run.snapshot as { values: { title: string } }).values.title).toBe("ספר ישן מנחה");
    expect((run.result as AnalysisResult).findings[0]!.transcription).toBe("שייך לה\"ה — יעקב");

    const actions = (await db.auditLog.findMany({ where: { inventoryItemId: item.id }, select: { action: true, userId: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["ai.requested", "ai.completed"]));
    const ev = await db.inventoryStatusEvent.findFirst({ where: { inventoryItemId: item.id, dimension: "REVIEW" } });
    expect(ev).toMatchObject({ fromStatus: "NOT_STARTED", toStatus: "PENDING_REVIEW", refType: "ai" });

    const state = await getAiState(ctx.viewer, item.id);
    expect(state).toMatchObject({ aiStatus: "COMPLETED", hasSuccessfulAnalysis: true, needsApproval: true, reviewStatus: "PENDING_REVIEW" });
    expect(state.latest?.applied?.review.some((r) => r.field === "printYear")).toBe(true);
  });

  it("no duplicates: same request key → same run; a second run while one is active is refused", async () => {
    const { item } = await createBook(ctx.editor, { title: "כפילויות" });
    const key = randomUUID();
    const a = await requestAnalysis(ctx.editor, item.id, { requestKey: key });
    const b = await requestAnalysis(ctx.editor, item.id, { requestKey: key });
    expect(b).toEqual({ runId: a.runId, existing: true });
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() })).rejects.toThrow(/כבר פעיל/);
    const parallel = await Promise.allSettled([1, 2, 3].map(() => requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() })));
    expect(parallel.every((p) => p.status === "rejected")).toBe(true);
    expect(await db.job.count({ where: { type: "AI_ANALYZE", payload: { path: ["itemId"], equals: item.id } } })).toBe(1);
    // a second worker / a restarted job never runs it twice
    await runAnalysis(a.runId);
    await runAnalysis(a.runId);
    expect(fake.requests).toHaveLength(1);
  });

  it("re-analysis needs a manager's password (server side) and is rate limited; its result is saved for comparison and the item is not touched", async () => {
    const { item } = await createBook(ctx.editor, { title: "לניתוח חוזר" });
    await analyse(ctx.editor, item.id);
    await startReview(ctx.editor, item.id);
    const v = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    await approveReview(ctx.admin, item.id, { detailsVersion: v });

    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() })).rejects.toThrow(/אישור מנהל/);
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: ctx.admin.email, password: "wrong-password" } })).rejects.toThrow(/אימות המנהל נכשל/);
    // a valid password of a non-manager is not an approval
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: ctx.editor.email, password: EDITOR_PASSWORD } })).rejects.toThrow(/אימות המנהל נכשל/);
    // a manager of another organization is not an approval either
    await db.user.update({ where: { id: other.admin.userId }, data: { passwordHash: await hashPassword(ADMIN_PASSWORD) } });
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: other.admin.email, password: ADMIN_PASSWORD } })).rejects.toThrow(/אימות המנהל נכשל/);
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "ai.reanalysis_denied" } })).toBe(3);

    fake.answer = () => goodResult({}, { printYear: f("תקס\"א [1801]") });
    const run = await analyse(ctx.editor, item.id, { email: ctx.admin.email, password: ADMIN_PASSWORD }, true);
    expect(run).toMatchObject({ status: "COMPLETED", isReanalysis: true, approvedById: ctx.admin.userId, createdById: ctx.editor.userId });
    expect(run.applied).toBeNull(); // kept for comparison, not applied
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.printYear).toBe("תקנ\"ט [1799]"); // untouched: the first analysis' value is still there
    expect(after.reviewStatus).toBe("APPROVED");
    expect(after.approvedAt).not.toBeNull();
    expect(after.aiStatus).toBe("COMPLETED");
    expect((await getAiState(ctx.editor, item.id)).runs[0]).toMatchObject({ pendingApply: true, applied: false });
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "ai.reanalysis_approved", userId: ctx.editor.userId } })).toBe(1);

    // brute force: after 5 failures the requesting user is locked out for the window, even with the right password
    const { item: i2 } = await createBook(ctx.photographer, { title: "נעילה" });
    await analyse(ctx.photographer, i2.id);
    for (let k = 0; k < 5; k++) await requestAnalysis(ctx.photographer, i2.id, { requestKey: randomUUID(), approval: { email: `x${k}@example.test`, password: "nope" } }).catch(() => undefined);
    await expect(requestAnalysis(ctx.photographer, i2.id, { requestKey: randomUUID(), approval: { email: ctx.admin.email, password: ADMIN_PASSWORD } })).rejects.toThrow(/יותר מדי ניסיונות/);
  });

  it("provider failure: FAILED with the message, item details untouched, retry allowed while nothing succeeded yet", async () => {
    const { item } = await createBook(ctx.editor, { title: "כישלון", author: "מחבר ידני" });
    fake.failWith = new ProviderError("auth", "OpenAI: מפתח ה-API נדחה (401)");
    const run = await analyse(ctx.editor, item.id);
    expect(run).toMatchObject({ status: "FAILED", error: "OpenAI: מפתח ה-API נדחה (401)" });
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ title: "כישלון", author: "מחבר ידני", aiStatus: "FAILED", aiError: "OpenAI: מפתח ה-API נדחה (401)", reviewStatus: "NOT_STARTED", detailsVersion: item.detailsVersion });
    expect(after.aiCompletedAt).toBeNull();
    fake.failWith = null;
    const retry = await analyse(ctx.editor, item.id); // no approval needed: nothing succeeded before
    expect(retry.status).toBe("COMPLETED");
  });

  it("invalid JSON from the model: one repeat, then FAILED without touching the item; usage of both calls recorded", async () => {
    const { item } = await createBook(ctx.editor, { title: "JSON שבור" });
    fake.answer = () => "{ not json";
    const run = await analyse(ctx.editor, item.id);
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/JSON/);
    expect(run.requestCount).toBe(2);
    expect(run.inputTokens).toBe(10000);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).title).toBe("JSON שבור");
  });

  it("a rate limit is retried and then succeeds", async () => {
    const { item } = await createBook(ctx.editor, { title: "מגבלת קצב" });
    let n = 0;
    const orig = fake.generate.bind(fake);
    fake.generate = async (req) => {
      if (++n === 1) throw new ProviderError("rate_limit", "rate", { retryAfterMs: 10 });
      return orig(req);
    };
    const run = await analyse(ctx.editor, item.id);
    fake.generate = orig;
    expect(run.status).toBe("COMPLETED");
    expect(((run.usage as { calls: { ok: boolean }[] }).calls).map((c) => c.ok)).toEqual([false, true]);
  });

  it("a person editing during the analysis is never overwritten; the proposal is kept for review", async () => {
    const { item } = await createBook(ctx.editor, { title: "עריכה במקביל" });
    fake.answer = async () => {
      // the reviewer saves the author while the model is thinking
      await updateItem(ctx.editor, item.id, { author: "תיקון ידני" });
      return goodResult();
    };
    const run = await analyse(ctx.editor, item.id);
    expect(run.status).toBe("COMPLETED");
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.author).toBe("תיקון ידני");
    expect(after.printPlace).toBe("זולקווא");
    const applied = run.applied as { decisions: Record<string, { action: string }>; review: { field: string }[] };
    expect(applied.decisions.author!.action).toBe("skipped_human_edit");
    expect(applied.review.some((r) => r.field === "author")).toBe(true);
  });

  it("autosave with a stale version is refused (409) instead of overwriting the AI result", async () => {
    const { item } = await createBook(ctx.editor, { title: "גרסאות" });
    const v0 = item.detailsVersion;
    await analyse(ctx.editor, item.id);
    await expect(updateItem(ctx.editor, item.id, { title: "שמירה ישנה" }, { expectedVersion: v0 })).rejects.toThrow(/עודכנו בינתיים/);
    const v1 = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    const u = await updateItem(ctx.editor, item.id, { title: "שמירה חדשה" }, { expectedVersion: v1 });
    expect(u.detailsVersion).toBe(v1 + 1);
    expect(u.reviewStatus).toBe("IN_REVIEW"); // the first edit of a pending item starts the review
  });

  it("final approval is its own permission: an editor cannot approve, a user granted it can, and the approval records who, when and which version", async () => {
    const { item } = await createBook(ctx.editor, { title: "הרשאת אישור" });
    await analyse(ctx.editor, item.id);
    await startReview(ctx.editor, item.id);
    const v = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    await expect(approveReview(ctx.editor, item.id, { detailsVersion: v })).rejects.toThrow(/אין לך הרשאה/);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).reviewStatus).toBe("IN_REVIEW");
    const granted = { ...ctx.editor, extraPermissions: ["item.review.approve"] };
    await approveReview(granted, item.id, { detailsVersion: v });
    const it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it).toMatchObject({ reviewStatus: "APPROVED", approvedById: ctx.editor.userId, approvedVersion: v });
    expect(it.approvedAt).not.toBeNull();
    // a material change withdraws the approval; the audit keeps who approved before and when
    await updateItem(ctx.editor, item.id, { printPlace: "ונציה" });
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ reviewStatus: "IN_REVIEW", approvedById: null, approvedVersion: null });
    const log = await db.auditLog.findFirst({ where: { inventoryItemId: item.id, action: "item_review.invalidated" } });
    expect(log?.data).toMatchObject({ previousApprovedById: ctx.editor.userId, previousApprovedVersion: v });
  });

  it("review: start, approve only with the version seen, a material change withdraws the approval; reviewer changes recorded", async () => {
    const { item } = await createBook(ctx.editor, { title: "בדיקה" });
    const run = await analyse(ctx.editor, item.id);
    await startReview(ctx.editor, item.id);
    let it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it).toMatchObject({ reviewStatus: "IN_REVIEW", reviewChangedById: ctx.editor.userId });
    await updateItem(ctx.editor, item.id, { printPlace: "לבוב" }, { expectedVersion: it.detailsVersion });
    await expect(approveReview(ctx.admin, item.id, { detailsVersion: it.detailsVersion })).rejects.toThrow(/השתנו מאז/);
    it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    await approveReview(ctx.admin, item.id, { detailsVersion: it.detailsVersion });
    it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it).toMatchObject({ reviewStatus: "APPROVED", approvedById: ctx.admin.userId });
    const outcome = (await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: run.id } })).reviewOutcome as { changed: string[]; aiWritten: number };
    expect(outcome.changed).toEqual(["printPlace"]);
    expect(outcome.aiWritten).toBeGreaterThan(3);

    // a non-material edit keeps the approval, a material one withdraws it
    await updateItem(ctx.editor, item.id, { internalNotes: "הערה" });
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).reviewStatus).toBe("APPROVED");
    await updateItem(ctx.editor, item.id, { author: "מחבר אחר" });
    it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it.reviewStatus).toBe("IN_REVIEW");
    expect(it.approvedAt).toBeNull();
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "item_review.invalidated" } })).toBe(1);
    const actions = (await db.auditLog.findMany({ where: { inventoryItemId: item.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["item_review.started", "item_review.approved"]));
  });

  it("restore puts back the values from before the run (including manual ones), and is logged", async () => {
    const { item } = await createBook(ctx.editor, { title: "שם שהוזן ידנית", conditionNotes: "כריכה קרועה" });
    const run = await analyse(ctx.editor, item.id);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).conditionNotes).toBe("כתמים - בלאי. קרעים בשוליים.");
    const r = await restoreRun(ctx.editor, run.id);
    expect(r.fields).toEqual(expect.arrayContaining(["conditionNotes", "catalogDescription"]));
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ title: "שם שהוזן ידנית", conditionNotes: "כריכה קרועה", catalogDescription: null, author: null });
    await expect(restoreRun(ctx.editor, run.id)).rejects.toThrow(/כבר שוחזר/);
    await expect(restoreRun(other.admin, run.id)).rejects.toThrow(/לא נמצא/);
    const log = await db.auditLog.findFirstOrThrow({ where: { inventoryItemId: item.id, action: "ai.restored" } });
    expect((log.data as { replacedValues: { conditionNotes: string } }).replacedValues.conditionNotes).toBe("כתמים - בלאי. קרעים בשוליים.");
  });

  it("catalog: a lot in preparation gets the draft as a new AI description version; an offered lot is never touched", async () => {
    const draft = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `AI-D-${Date.now()}`, name: "בהכנה" });
    const { item } = await createBook(ctx.editor, { title: "בקטלוג טיוטה" });
    const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: draft.id });
    await analyse(ctx.editor, item.id);
    const l = await db.lot.findUniqueOrThrow({ where: { id: lot.id }, include: { descriptionVersions: { orderBy: { version: "asc" } } } });
    expect(l.title).toBe("בקטלוג טיוטה"); // the name is only proposed, so the lot keeps it too
    expect(l.author).toBe("רבינו בחיי אבן פקודה");
    expect(l.description).toContain("ספר חובות הלבבות. זולקווא");
    expect(l.descriptionVersions.map((v) => v.source)).toEqual(["MANUAL", "AI"]);

    const { item: i2 } = await createBook(ctx.editor, { title: "בקטלוג פעיל" });
    const lot2 = await assignToCatalog(ctx.editor, i2.id, { catalogId: draft.id, description: "תיאור שפורסם" });
    await db.lot.update({ where: { id: lot2.id }, data: { commercialStatus: "OFFERED" } });
    const run2 = await analyse(ctx.editor, i2.id);
    const l2 = await db.lot.findUniqueOrThrow({ where: { id: lot2.id }, include: { descriptionVersions: true } });
    expect(l2).toMatchObject({ title: "בקטלוג פעיל", description: "תיאור שפורסם" });
    expect(l2.descriptionVersions).toHaveLength(1);
    expect((run2.applied as { lot: { skippedReason: string } }).lot.skippedReason).toMatch(/כבר הוצע/);

    // a catalog-specific edit of the lot is never overwritten either
    const { item: i4 } = await createBook(ctx.editor, { title: "שם במלאי" });
    const lot4 = await assignToCatalog(ctx.editor, i4.id, { catalogId: draft.id, description: "תיאור שנכתב בקטלוג" });
    await db.lot.update({ where: { id: lot4.id }, data: { title: "שם שנערך בקטלוג" } });
    await analyse(ctx.editor, i4.id);
    expect(await db.lot.findUniqueOrThrow({ where: { id: lot4.id } })).toMatchObject({ title: "שם שנערך בקטלוג", description: "תיאור שנכתב בקטלוג", author: "רבינו בחיי אבן פקודה" });

    // no lot yet: the draft on the item seeds a future assignment
    const { item: i3 } = await createBook(ctx.editor, { title: "בלי קטלוג" });
    await analyse(ctx.editor, i3.id);
    const lot3 = await assignToCatalog(ctx.editor, i3.id, { catalogId: draft.id });
    const l3 = await db.lot.findUniqueOrThrow({ where: { id: lot3.id }, include: { descriptionVersions: true } });
    expect(l3.shortDescription).toBe("ספר חובות הלבבות - זולקווא");
    expect(l3.descriptionVersions[0]!.source).toBe("AI");
  });

  it("many images: staged requests, every image documented and sent exactly once; missing files reported, not dropped", async () => {
    process.env.BOOK_AI_MAX_IMAGES_PER_REQUEST = "3";
    const { item } = await createBook(ctx.editor, { title: "תמונות רבות" });
    await addPhoto(item.id, "COVER", 1);
    await addPhoto(item.id, "TITLE_PAGE", 2);
    for (let s = 3; s <= 8; s++) await addPhoto(item.id, "INTERIOR", s);
    await addPhoto(item.id, "INTERIOR", 9, { missing: true });
    fake.answer = (req) =>
      req.schemaName === "item_observations"
        ? { images: req.images.map((i) => ({ imageId: i.id, shows: "דף פנים", transcriptions: [], findings: [], condition: null })), summary: "דפי פנים" }
        : goodResult();
    const run = await analyse(ctx.editor, item.id);
    expect(run.status).toBe("COMPLETED");
    const sent = fake.requests.flatMap((r) => r.images.map((i) => i.id));
    expect(new Set(sent).size).toBe(sent.length);
    expect(fake.requests.length).toBeGreaterThan(2);
    expect(fake.requests.at(-1)!.schemaName).toBe("item_analysis");
    expect(fake.requests.at(-1)!.userText).toContain("תצפיות מהשלב הקודם");
    const images = (run.input as { images: { status: string; reason?: string; sentIn?: string[] }[] }).images;
    expect(images).toHaveLength(9);
    expect(images.filter((i) => i.status === "prepared").every((i) => i.sentIn?.length === 1)).toBe(true);
    expect(images.find((i) => i.status === "skipped")?.reason).toMatch(/חסר באחסון/);
    expect(run.requestCount).toBe(fake.requests.length);
  });

  it("an item without photos and a non-book item: analysed, irrelevant fields not forced, existing values kept", async () => {
    const { item } = await createBook(ctx.editor, { title: "כרזה", printPlace: "ירושלים" });
    fake.answer = () =>
      goodResult(
        { itemType: { value: "POSTER", confidence: "high", note: null } },
        { title: f("כרזה - קריאה לאסיפה"), author: f(null, { status: "not_applicable" }), printPlace: f(null, { status: "not_checked" }), printYear: f(null), conditionNotes: f(null) },
      );
    const run = await analyse(ctx.editor, item.id);
    expect(fake.requests[0]!.images).toHaveLength(0);
    expect(fake.requests[0]!.userText).toContain("לא צורפו תמונות");
    expect(run.imageCount).toBe(0);
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ itemType: "POSTER", title: "כרזה", printPlace: "ירושלים", author: null });
  });

  it("no title-page photo (a poster): the first photo is the main page - detail and zooms; the others stay ordinary", async () => {
    const { item } = await createBook(ctx.editor, { title: "כרוז" });
    await addPhoto(item.id, "COVER", 1);
    await addPhoto(item.id, "COVER", 2);
    await analyse(ctx.editor, item.id);
    const req = fake.requests.at(-1)!;
    expect(req.images.map((i) => [i.id, i.detail])).toEqual([
      ["img-01", "high"],
      ["img-01-top", "high"],
      ["img-01-bottom", "high"],
      ["img-02", "auto"],
    ]);
  });

  it("inventory table: review-status column data, filter, and the 'דורשים בדיקה אנושית' view", async () => {
    const { item } = await createBook(ctx.editor, { title: "לסינון" });
    await analyse(ctx.editor, item.id);
    const all = await listInventory(ctx.editor, { view: "needs_review", pageSize: 500 });
    expect(all.items.every((r) => r.reviewStatus === "PENDING_REVIEW" || r.reviewStatus === "IN_REVIEW")).toBe(true);
    expect(all.items.some((r) => r.id === item.id)).toBe(true);
    const row = all.items.find((r) => r.id === item.id)!;
    expect(row).toMatchObject({ aiStatus: "COMPLETED", hasAiResult: true });
    const pending = await listInventory(ctx.editor, { reviewStatus: "PENDING_REVIEW", q: "חובות", pageSize: 500 });
    expect(pending.items.every((r) => r.reviewStatus === "PENDING_REVIEW")).toBe(true);
    expect((await listInventory(ctx.editor, { reviewStatus: "APPROVED", q: "לסינון" })).items).toHaveLength(0);
  });

  it("organization isolation: another organization cannot see, start or restore", async () => {
    const { item } = await createBook(ctx.editor, { title: "פרטי" });
    await expect(getAiState(other.admin, item.id)).rejects.toThrow(/לא נמצא/);
    await expect(requestAnalysis(other.admin, item.id, { requestKey: randomUUID() })).rejects.toThrow(/לא נמצא/);
    await expect(startReview(other.admin, item.id)).rejects.toThrow(/לא נמצא/);
    const rows = await listRunsForReport(other.org.id);
    expect(rows.every((r) => r.inventoryNumber !== item.inventoryNumber)).toBe(true);
  });

  it("an orphaned run (its job lost) is marked FAILED by maintenance; the report lists runs with cost", async () => {
    const { item } = await createBook(ctx.editor, { title: "יתום" });
    const r = await requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() });
    const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: r.runId } });
    await db.job.update({ where: { id: run.jobId! }, data: { status: "FAILED" } });
    await db.inventoryAnalysis.update({ where: { id: r.runId }, data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await recoverOrphanRuns();
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).aiStatus).toBe("FAILED");
    const rows = await listRunsForReport(ctx.org.id);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((x) => typeof x.costUsd === "number" && x.costUsd > 0)).toBe(true);
  });

  it("an answer that explains in English is asked for once more in Hebrew; the Hebrew answer is the one applied", async () => {
    const { item } = await createBook(ctx.editor, { title: "כרוז" });
    fake.answer = (_req, n) =>
      n === 1
        ? goodResult({ identification: { summary: "A pashkevil issued by the Chief Rabbinate, calling for a work stoppage.", existingTitleCheck: "matches", conflicts: [] } }, { title: f("בטול מלאכה", { note: "The main headline of the poster." }) })
        : goodResult({ identification: { summary: "כרוז מטעם הרבנות הראשית הקורא לביטול מלאכה.", existingTitleCheck: "matches", conflicts: [] } }, { title: f("בטול מלאכה", { note: "הכותרת הראשית של הכרוז." }) });
    const run = await analyse(ctx.editor, item.id);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.userText).toContain("כתבה הסברים באנגלית");
    expect(run.status).toBe("COMPLETED");
    expect((run.result as AnalysisResult).identification.summary).toBe("כרוז מטעם הרבנות הראשית הקורא לביטול מלאכה.");
    // both calls are paid for and recorded
    expect(run.requestCount).toBe(2);
    // a foreign imprint copied in quotes is not "English prose": no second call
    fake.requests = [];
    const { item: other } = await createBook(ctx.editor, { title: "ספר" });
    fake.answer = () => goodResult({}, { publisher: f("Nela Stamparia Bragadina", { note: "נדפס בשולי השער בלועזית: 'Nela Stamparia Bragadina'" }) });
    await analyse(ctx.editor, other.id);
    expect(fake.requests).toHaveLength(1);
  });

  it("BOOK_AI_INLINE: the job is never QUEUED (no worker can claim it); the request process runs and closes it", async () => {
    const { item } = await createBook(ctx.editor, { title: "ספר בהרצה מקומית" });
    process.env.BOOK_AI_INLINE = "true";
    try {
      const r = await requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() });
      const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: r.runId } });
      expect(await db.job.count({ where: { id: run.jobId!, status: "QUEUED" } })).toBe(0);
      let job = await db.job.findUniqueOrThrow({ where: { id: run.jobId! } });
      for (let k = 0; k < 100 && job.status === "RUNNING"; k++) {
        await new Promise((res) => setTimeout(res, 100));
        job = await db.job.findUniqueOrThrow({ where: { id: run.jobId! } });
      }
      expect(job.status).toBe("SUCCEEDED");
      expect((await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe("COMPLETED");
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).reviewStatus).toBe("PENDING_REVIEW");
    } finally {
      delete process.env.BOOK_AI_INLINE;
    }
  });

  /* ───────── clean re-analysis, baseline, compare, apply, settings, patch ───────── */

  const SENTINEL = "OLD_AI_SENTINEL_92471";
  const adminApproval = () => ({ email: ctx.admin.email, password: ADMIN_PASSWORD });
  const everything = (req: ProviderRequest) => [req.instructions, req.userText, req.schemaName, JSON.stringify(req.schema), ...req.images.map((i) => i.label)].join("\n");
  const poisoned = () =>
    goodResult(
      {
        identification: { summary: `${SENTINEL} סיכום`, existingTitleCheck: "more_precise_available", conflicts: [`${SENTINEL} סתירה`] },
        catalog: { headline: `${SENTINEL} כותרת`, description: `${SENTINEL} תיאור\n\nמצב טוב.`, confidence: "high" },
        findings: [{ kind: "signature", imageIds: ["img-01"], transcription: SENTINEL, reading: "probable", attribution: SENTINEL, attributionBasis: SENTINEL, significance: SENTINEL }],
        requiresReview: [{ field: "author", reason: SENTINEL }],
        warnings: [SENTINEL],
      },
      { author: f(`${SENTINEL} מחבר`), printYear: f(`${SENTINEL} שנה`), subtitle: f(`${SENTINEL} משנה`), bibliographicNotes: f(`${SENTINEL} ביבליוגרפיה`), conditionNotes: f(`${SENTINEL} מצב`) },
    );

  it("SENTINEL: a clean re-analysis never sends the first analysis' output (not in the prompt, not in any stage), but still sends the original data", async () => {
    process.env.BOOK_AI_MAX_IMAGES_PER_REQUEST = "2"; // forces the staged flow: the observation stage is checked too
    const { item } = await createBook(ctx.editor, { title: "ספר לדוגמה", subtitle: "כותרת משנה מקורית" });
    await db.inventoryItem.update({ where: { id: item.id }, data: { photographerNotes: "הערת מצלם מקורית: השער חסר" } });
    for (let s = 1; s <= 4; s++) await addPhoto(item.id, s === 1 ? "COVER" : "INTERIOR", s);
    const stage = (req: ProviderRequest) => (req.schemaName === "item_observations" ? { images: req.images.map((i) => ({ imageId: i.id, shows: "דף", transcriptions: [], findings: [], condition: null })), summary: "דפים" } : null);

    fake.answer = (req) => stage(req) ?? poisoned();
    await analyse(ctx.editor, item.id);
    const first = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    // the first analysis' output is now everywhere on the item
    expect(first.author).toContain(SENTINEL);
    expect(first.catalogDescription).toContain(SENTINEL);
    expect(first.bibliographicNotes).toContain(SENTINEL);
    // ...and a person edited fields after it, keeping the AI text inside them
    await updateItem(ctx.editor, item.id, { bibliographicNotes: `ערוך ידנית. ${first.bibliographicNotes}`, author: `${first.author} (תוקן)` });
    const edited = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(edited.author).toContain(SENTINEL);
    await updateItem(ctx.editor, item.id, { catalogDescription: "תיאור קטלוגי שנכתב ידנית" }); // a manual catalog draft

    fake.requests = [];
    fake.answer = (req) => stage(req) ?? goodResult();
    const second = await analyse(ctx.editor, item.id, adminApproval());
    expect(second.status).toBe("COMPLETED");
    expect(fake.requests.length).toBeGreaterThan(1); // observation stage(s) + final
    expect(fake.requests.some((r) => r.schemaName === "item_observations")).toBe(true);
    for (const req of fake.requests) {
      expect(everything(req)).not.toContain("OLD_AI_SENTINEL");
      expect(everything(req)).not.toContain(first.catalogDescription!.slice(0, 30));
    }
    // the original data is what the model got
    const text = fake.requests.at(-1)!.userText;
    expect(text).toContain("ספר לדוגמה");
    expect(text).toContain("כותרת משנה מקורית");
    expect(text).toContain("הערת מצלם מקורית");
    // the re-analysis filled everything anew: nothing of the first analysis is left on the item
    const refilled = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refilled.author).toBe("רבינו בחיי אבן פקודה");
    expect(refilled.catalogDescription).not.toContain(SENTINEL);
    expect(refilled.catalogDescription).not.toBe("תיאור קטלוגי שנכתב ידנית"); // re-analysis refills the catalog too
    expect(refilled.catalogHeadline).toBe("ספר חובות הלבבות - זולקווא");
    expect(refilled.printYear).toBe("תקנ\"ט [1799]"); // every field, not only the catalog
    expect(refilled.reviewStatus).toBe("PENDING_REVIEW");
    // the run says what the input was
    const input = second.input as { baseline: { source: string; missing: string[] }; settings: { model: string }; inputFingerprint: string };
    expect(input.baseline).toMatchObject({ source: "captured_before_first_analysis", missing: [] });
    expect(input.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("baseline: fixed before the first analysis; an item analysed before it existed is reconstructed from the first run's start values, never from today's fields", async () => {
    const { item } = await createBook(ctx.editor, { title: "ספר ישן", author: "מחבר מקורי" });
    await analyse(ctx.editor, item.id);
    const fixed = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).originalBaseline as { fields: { title: string; author: string; printPlace: string | null } };
    expect(fixed.fields).toMatchObject({ title: "ספר ישן", author: "מחבר מקורי", printPlace: null });
    // it never moves, whatever happens to the item afterwards
    await updateItem(ctx.editor, item.id, { author: "שונה אחר כך" });
    await analyse(ctx.editor, item.id, adminApproval());
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).originalBaseline).toEqual(fixed);

    // legacy item: no stored baseline, only the first run's recorded start values
    await db.inventoryItem.update({ where: { id: item.id }, data: { originalBaseline: Prisma.DbNull, originalBaselineAt: null } });
    const legacy = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, include: { categoryNotes: true } });
    const rebuilt = await computeBaseline(legacy);
    expect(rebuilt).toMatchObject({ source: "reconstructed_from_first_run", missing: [] });
    expect(rebuilt.fields).toMatchObject({ title: "ספר ישן", author: "מחבר מקורי", printPlace: null });
    expect(rebuilt.fields.printPlace).not.toBe("זולקווא"); // today's (AI) value is not used
    expect((await getAiState(ctx.editor, item.id)).baseline).toMatchObject({ saved: false, partial: false });

    // nothing provable (the first run recorded no start values): partial baseline, warned, and today's fields are NOT sent
    await db.inventoryAnalysis.updateMany({ where: { inventoryItemId: item.id }, data: { baseValues: Prisma.DbNull } });
    const partial = await computeBaseline(legacy);
    expect(partial.missing).toEqual(expect.arrayContaining(["title", "author", "printPlace"]));
    expect(partial.fields.author).toBeNull();
    fake.requests = [];
    const run = await analyse(ctx.editor, item.id, adminApproval());
    expect(run.status).toBe("COMPLETED");
    expect(fake.requests[0]!.userText).not.toContain("זולקווא");
    expect((run.input as { baseline: { missing: string[] } }).baseline.missing.length).toBeGreaterThan(0);

    // an admin may confirm the current data as the original: explicit, logged, admin only
    await db.inventoryItem.update({ where: { id: item.id }, data: { originalBaseline: Prisma.DbNull } });
    const confirmed = await confirmBaselineFromCurrent(ctx.admin, item.id);
    expect(confirmed).toMatchObject({ source: "admin_confirmed", missing: [] });
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "ai.baseline_confirmed" } })).toBe(1);
    expect(can("EDITOR", "ai.reanalyze.approve")).toBe(false);
  });

  it("compare + apply: two runs side by side with the input differences; apply chosen fields only; restore; no double apply", async () => {
    const { item } = await createBook(ctx.editor, { title: "להשוואה" });
    await analyse(ctx.editor, item.id);
    fake.answer = () => goodResult({}, { printYear: f("תקס\"א [1801]"), publisher: f("דפוס חדש") });
    const second = await analyse(ctx.editor, item.id, adminApproval(), true);
    const firstRun = (await getAiState(ctx.editor, item.id)).runs.at(-1)!;

    const cmp = await compareRuns(ctx.editor, item.id, firstRun.id, second.id);
    expect(cmp.summary.onlyB).toContain("מדפיס");
    expect(cmp.summary.differ).toContain("שנת דפוס");
    expect(cmp.rows.find((r) => r.key === "printYear")).toMatchObject({ kind: "differs" });
    expect(cmp.comparable).toBe(true); // same original data, photos, prompt, examples: only the answer differs
    // a different input is called out: a photo was added between the runs
    await addPhoto(item.id, "COVER", 1);
    const third = await analyse(ctx.editor, item.id, adminApproval(), true);
    const cmp2 = await compareRuns(ctx.editor, item.id, second.id, third.id);
    expect(cmp2.comparable).toBe(false);
    expect(cmp2.warnings.join(" ")).toMatch(/תמונות/);
    await expect(compareRuns(other.admin, item.id, second.id, third.id)).rejects.toThrow(/לא נמצא/);
    await expect(compareRuns(ctx.editor, item.id, second.id, second.id)).rejects.toThrow(/שני ניתוחים/);

    // apply ONLY the chosen field; the rest of the item stays
    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    await startReview(ctx.editor, item.id);
    await approveReview(ctx.admin, item.id, { detailsVersion: (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion });
    const applied = await applyRun(ctx.editor, second.id, { fields: ["printYear"] });
    expect(applied.fields).toEqual(["printYear"]);
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ printYear: "תקס\"א [1801]", publisher: before.publisher, author: before.author, catalogDescription: before.catalogDescription, reviewStatus: "PENDING_REVIEW" });
    expect(after.detailsVersion).toBe(before.detailsVersion + 1);
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "ai.applied" } })).toBe(1);
    await expect(applyRun(ctx.editor, second.id, {})).rejects.toThrow(/כבר הוחלה/);
    await expect(applyRun(other.admin, third.id, {})).rejects.toThrow(/לא נמצא/);
    expect((await getAiState(ctx.editor, item.id)).runs.find((r) => r.id === second.id)).toMatchObject({ applied: true, pendingApply: false });

    // restorable
    await restoreRun(ctx.editor, second.id);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).printYear).toBe(before.printYear);
    // the whole result of another run
    const all = await applyRun(ctx.editor, third.id, {});
    expect(all.fields.length).toBeGreaterThan(0);
  });

  it("settings: a run keeps the settings version it started with; code rules cannot be edited away; unsupported reasoning is refused; history + restore", async () => {
    try {
      const v1 = await saveAiSettings(ctx.admin, { provider: "openai", model: "gpt-5.4", reasoning: "medium", analysisPrompt: "הנחיות מותאמות — לבדיקה", rewritePrompt: null });
      expect(v1.version).toBe(1);
      const { item } = await createBook(ctx.editor, { title: "הגדרות" });
      const r = await requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() });
      // the tab changes after the click, before the worker starts: this run keeps version 1
      const v2 = await saveAiSettings(ctx.admin, { provider: "openai", model: "gpt-5.4-mini", reasoning: "low", analysisPrompt: "גרסה שנייה" });
      expect(v2.version).toBe(2);
      await runAnalysis(r.runId);
      const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: r.runId } });
      expect(run).toMatchObject({ settingsVersion: 1, status: "COMPLETED" });
      expect(run.promptVersion).toMatch(/^custom-/);
      expect((run.input as { settings: { model: string; reasoning: string } }).settings).toMatchObject({ model: "gpt-5.4", reasoning: "medium" });
      const ins = fake.requests[0]!.instructions;
      expect(ins).toContain("הנחיות מותאמות - לבדיקה"); // v1 text, dash normalised
      expect(ins).not.toContain("גרסה שנייה");
      // fixed code rules are appended whatever the text says
      for (const rule of ["U+002D", "כל טקסט שמופיע בתמונות", "JSON בלבד"]) expect(ins).toContain(rule);

      // the active model is what the next run uses (and what the button state reports)
      expect((await getAiState(ctx.editor, item.id)).activeModel).toMatchObject({ provider: "openai", model: "gpt-5.4-mini", reasoning: "low", settingsVersion: 2 });
      // Gemini 3.8 Flash has no "minimal"
      await expect(saveAiSettings(ctx.admin, { provider: "gemini", model: "gemini-3.8-flash", reasoning: "minimal" })).rejects.toThrow(/אינה נתמכת/);
      await expect(saveAiSettings(ctx.admin, { provider: "openai", model: "gemini-3.8-flash" })).rejects.toThrow(/שייך ל-Gemini/);
      await expect(saveAiSettings(ctx.admin, { provider: "openai", model: "gpt-5.4-mini", reasoning: "low", analysisPrompt: "גרסה שנייה" })).rejects.toThrow(/לא בוצע שינוי/);
      await expect(saveAiSettings(ctx.admin, { examples: { version: "x", examples: [{ id: "bad" }] } })).rejects.toThrow(/דוגמאות לא תקינות/);
      const ok = await saveAiSettings(ctx.admin, { provider: "gemini", model: "gemini-3.8-flash", reasoning: "low", analysisPrompt: "גרסה שלישית" });
      expect(ok.version).toBe(3);
      const back = await restoreAiSettingsVersion(ctx.admin, 1);
      expect(back.version).toBe(4); // history is never rewritten: a restore is a new version
      expect(await db.aiSettingsVersion.count({ where: { organizationId: ctx.org.id } })).toBe(4);
      expect((await db.aiSettings.findUniqueOrThrow({ where: { organizationId: ctx.org.id } })).model).toBe("gpt-5.4");
      expect(can("ADMIN", "ai.settings")).toBe(true);
      expect(can("EDITOR", "ai.settings")).toBe(false);
    } finally {
      await db.aiSettings.deleteMany({ where: { organizationId: ctx.org.id } });
      await db.aiSettingsVersion.deleteMany({ where: { organizationId: ctx.org.id } });
    }
  });

  it("targeted rewrite (patch): only what was asked changes, unverifiable operations are skipped, a change made meanwhile voids the answer", async () => {
    const { item } = await createBook(ctx.editor, { title: "ספר לתיקון", author: "רבי יוסף", printPlace: "לבוב", printYear: "תקנ\"ט [1799]" });
    const description = "ספר לתיקון, מאת רבי יוסף. לבוב, תקנ\"ט [1799].\n\nתוכן החיבור.\n\nמצב: כתמים.";
    await db.inventoryItem.update({ where: { id: item.id }, data: { catalogDescription: description, catalogHeadline: "ספר לתיקון - לבוב", conditionNotes: "כתמים.", bibliographicNotes: "פרט ביבליוגרפי." } });
    const saved = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });

    fake.answer = () => ({
      ops: [
        { field: "catalogDescription", op: "add", target: null, anchor: "תוכן החיבור.", content: "בשער חתימת בעלים של רבי משה (img-02).", reason: "הוספת חתימה" },
        { field: "printYear", op: "replace", target: null, anchor: null, content: "תקס\"א [1801]", reason: "תיקון שנה" },
        { field: "catalogDescription", op: "replace", target: "תקנ\"ט [1799]", anchor: null, content: "תקס\"א [1801]", reason: "אזכור השנה בתיאור" },
        { field: "conditionNotes", op: "replace", target: "טקסט שלא קיים", anchor: null, content: "משהו", reason: null },
        { field: "author", op: "delete", target: "שם אחר", anchor: null, content: null, reason: null },
      ],
    });
    const r = await rewriteCatalog(ctx.editor, item.id, { mode: "patch", additions: "בשער חתימת בעלים של רבי משה. השנה היא תקס\"א. טל' 050-1234567" });
    expect(fake.requests[0]!.schemaName).toBe("catalog_patch");
    expect(fake.requests[0]!.userText).not.toContain("050-1234567");
    // only the changed fields come back; untouched ones are not returned at all
    expect(Object.keys(r.fields).sort()).toEqual(["catalogDescription", "printYear"]);
    expect(r.fields.printYear).toBe("תקס\"א [1801]");
    expect(r.fields.catalogDescription).toBe("ספר לתיקון, מאת רבי יוסף. לבוב, תקס\"א [1801].\n\nתוכן החיבור.\n\nבשער חתימת בעלים של רבי משה.\n\nמצב: כתמים.");
    expect(r.skipped.map((x) => x.field).sort()).toEqual(["author", "conditionNotes"]);
    // nothing was written
    const still = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(still).toMatchObject({ catalogDescription: description, printYear: saved.printYear, author: saved.author, conditionNotes: saved.conditionNotes, detailsVersion: saved.detailsVersion });
    expect(await db.inventoryAnalysis.count({ where: { id: r.runId, kind: "catalog_rewrite", status: "COMPLETED" } })).toBe(1);

    // empty instruction in patch mode: refused before anything is sent
    fake.requests = [];
    await expect(rewriteCatalog(ctx.editor, item.id, { mode: "patch", additions: "" })).rejects.toThrow(/המידע להוספה/);
    expect(fake.requests).toHaveLength(0);
    // a person saves the details while the model works: the answer was built on text that no longer exists
    fake.answer = async () => {
      await updateItem(ctx.editor, item.id, { author: "נערך בינתיים" });
      return { ops: [{ field: "author", op: "replace", target: null, anchor: null, content: "אחר", reason: null }] };
    };
    await expect(rewriteCatalog(ctx.editor, item.id, { mode: "patch", additions: "תקן מחבר" })).rejects.toThrow(/עודכנו בזמן השכתוב/);
  });
});
