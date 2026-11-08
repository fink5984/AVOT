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
import { getAiState, recoverOrphanRuns, requestAnalysis, restoreRun, runAnalysis, listRunsForReport } from "@/server/services/ai-analysis";
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
  async function analyse(user = ctx.photographer, itemId: string, approval?: { email: string; password: string }) {
    const r = await requestAnalysis(user, itemId, { requestKey: randomUUID(), approval });
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
    expect(after).toMatchObject({ title: "ספר חובות הלבבות", author: "רבינו בחיי אבן פקודה", printPlace: "זולקווא", itemType: "BOOK", aiStatus: "COMPLETED", reviewStatus: "PENDING_REVIEW", catalogDescriptionSource: "AI" });
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

  it("re-analysis needs a manager's password (server side), is rate limited, and returns the item to PENDING_REVIEW", async () => {
    const { item } = await createBook(ctx.editor, { title: "לניתוח חוזר" });
    await analyse(ctx.editor, item.id);
    await startReview(ctx.editor, item.id);
    const v = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    await approveReview(ctx.editor, item.id, { detailsVersion: v });

    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID() })).rejects.toThrow(/אישור מנהל/);
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: ctx.admin.email, password: "wrong-password" } })).rejects.toThrow(/אימות המנהל נכשל/);
    // a valid password of a non-manager is not an approval
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: ctx.editor.email, password: EDITOR_PASSWORD } })).rejects.toThrow(/אימות המנהל נכשל/);
    // a manager of another organization is not an approval either
    await db.user.update({ where: { id: other.admin.userId }, data: { passwordHash: await hashPassword(ADMIN_PASSWORD) } });
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: other.admin.email, password: ADMIN_PASSWORD } })).rejects.toThrow(/אימות המנהל נכשל/);
    expect(await db.auditLog.count({ where: { inventoryItemId: item.id, action: "ai.reanalysis_denied" } })).toBe(3);

    fake.answer = () => goodResult({}, { printYear: f("תקס\"א [1801]") });
    const run = await analyse(ctx.editor, item.id, { email: ctx.admin.email, password: ADMIN_PASSWORD });
    expect(run).toMatchObject({ status: "COMPLETED", isReanalysis: true, approvedById: ctx.admin.userId, createdById: ctx.editor.userId });
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.printYear).toBe("תקס\"א [1801]"); // replaced the previous AI value
    expect(after.reviewStatus).toBe("PENDING_REVIEW");
    expect(after.approvedAt).toBeNull();
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
    expect(after.title).toBe("ספר חובות הלבבות");
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

  it("review: start, approve only with the version seen, a material change withdraws the approval; reviewer changes recorded", async () => {
    const { item } = await createBook(ctx.editor, { title: "בדיקה" });
    const run = await analyse(ctx.editor, item.id);
    await startReview(ctx.editor, item.id);
    let it = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it).toMatchObject({ reviewStatus: "IN_REVIEW", reviewChangedById: ctx.editor.userId });
    await updateItem(ctx.editor, item.id, { printPlace: "לבוב" }, { expectedVersion: it.detailsVersion });
    await expect(approveReview(ctx.editor, item.id, { detailsVersion: it.detailsVersion })).rejects.toThrow(/השתנו מאז/);
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
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).title).toBe("ספר חובות הלבבות");
    const r = await restoreRun(ctx.editor, run.id);
    expect(r.fields).toEqual(expect.arrayContaining(["title", "conditionNotes", "catalogDescription"]));
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ title: "שם שהוזן ידנית", conditionNotes: "כריכה קרועה", catalogDescription: null, author: null });
    await expect(restoreRun(ctx.editor, run.id)).rejects.toThrow(/כבר שוחזר/);
    await expect(restoreRun(other.admin, run.id)).rejects.toThrow(/לא נמצא/);
    const log = await db.auditLog.findFirstOrThrow({ where: { inventoryItemId: item.id, action: "ai.restored" } });
    expect((log.data as { replacedValues: { title: string } }).replacedValues.title).toBe("ספר חובות הלבבות");
  });

  it("catalog: a lot in preparation gets the draft as a new AI description version; an offered lot is never touched", async () => {
    const draft = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `AI-D-${Date.now()}`, name: "בהכנה" });
    const { item } = await createBook(ctx.editor, { title: "בקטלוג טיוטה" });
    const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: draft.id });
    await analyse(ctx.editor, item.id);
    const l = await db.lot.findUniqueOrThrow({ where: { id: lot.id }, include: { descriptionVersions: { orderBy: { version: "asc" } } } });
    expect(l.title).toBe("ספר חובות הלבבות");
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
    expect(after).toMatchObject({ itemType: "POSTER", title: "כרזה - קריאה לאסיפה", printPlace: "ירושלים", author: null });
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
});
