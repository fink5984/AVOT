import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog } from "@/server/services/assignments";
import { updateItem } from "@/server/services/inventory";
import { AiDeferred, requestAnalysis, runAnalysis } from "@/server/services/ai-analysis";
import { finishCapture } from "@/server/services/capture-finish";
import { photoReadiness } from "@/server/services/photo-readiness";
import { addReviewNote, listReviewNotes, noteStamp, openNoteCounts, updateReviewNote } from "@/server/services/review-notes";
import { resolveCatalogDraft } from "@/server/services/lot-draft-actions";
import { draftComparison } from "@/server/services/lot-sync";
import { updateLot } from "@/server/services/lots";
import { setProviderOverride } from "@/server/ai/providers";
import type { AiProvider, ProviderRequest, ProviderResponse } from "@/server/ai/providers/types";
import { PHOTO_GATE_MESSAGE } from "@/lib/photo-gate";
import { createBook, hasDb, makeOrg } from "./helpers";

/* A provider that only records: the gate must keep every request away from it. */
class RecordingProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly model = "gpt-5.4-mini";
  requests: ProviderRequest[] = [];
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    throw new Error("the model must not be called in this spec");
  }
}

describe.skipIf(!hasDb)("editor workspace: AI photography gate, review notes, book ⇄ lot text (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  const provider = new RecordingProvider();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "sk-it-not-used";
    process.env.BOOK_AI_PROVIDER = "openai";
    ctx = await makeOrg("workspace");
    setProviderOverride(provider);
  });
  afterAll(() => {
    setProviderOverride(null);
    process.env = savedEnv;
  });

  const analysis = (user = ctx.editor, itemId: string) => requestAnalysis(user, itemId, { requestKey: randomUUID() });
  const setPhoto = (itemId: string, photoStatus: "NOT_STARTED" | "IN_PROGRESS" | "PENDING_REVIEW" | "COMPLETED" | "NEEDS_RESHOOT") => db.inventoryItem.update({ where: { id: itemId }, data: { photoStatus } });
  async function addAsset(itemId: string, over: { upload?: "PENDING" | "UPLOADING" | "VERIFIED" | "FAILED"; imageState?: "NONE" | "QUEUED" | "PREVIEW_READY" | "DONE" | "FAILED" | "NEEDS_REVIEW" } = {}) {
    return db.photoAsset.create({
      data: {
        organizationId: ctx.org.id,
        inventoryItemId: itemId,
        category: "COVER",
        captureId: randomUUID(),
        source: "SIMULATOR",
        sequence: Math.floor(Math.random() * 1e6),
        sortOrder: 1,
        capturedAt: new Date(),
        imageState: over.imageState ?? "NONE",
        files: { create: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", extension: "jpg", sizeBytes: 10, sha256: "0".repeat(64), storageKey: `it/${randomUUID()}.jpg`, uploadStatus: over.upload ?? "VERIFIED" }] },
      },
    });
  }

  /* ───────────── section 4: no AI analysis before photography is complete ───────────── */

  it("every photography state except COMPLETED refuses an analysis with the clear message - before anything is queued", async () => {
    for (const status of ["NOT_STARTED", "IN_PROGRESS", "PENDING_REVIEW", "NEEDS_RESHOOT"] as const) {
      const { item } = await createBook(ctx.editor, { title: `צילום ${status}` });
      await setPhoto(item.id, status);
      await expect(analysis(ctx.editor, item.id)).rejects.toThrow(PHOTO_GATE_MESSAGE);
      const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.aiStatus).toBe("NOT_RUN");
      expect(await db.inventoryAnalysis.count({ where: { inventoryItemId: item.id } })).toBe(0);
      expect(await db.job.count({ where: { organizationId: ctx.org.id, type: "AI_ANALYZE", payload: { path: ["itemId"], equals: item.id } } })).toBe(0);
    }
    expect(provider.requests).toHaveLength(0);
  });

  it("a finished photography queues exactly one run; a second request is refused as a duplicate", async () => {
    const { item } = await createBook(ctx.editor, { title: "צילום הושלם" });
    await setPhoto(item.id, "COMPLETED");
    await addAsset(item.id);
    const key = randomUUID();
    const a = await requestAnalysis(ctx.editor, item.id, { requestKey: key });
    const b = await requestAnalysis(ctx.editor, item.id, { requestKey: key });
    expect(b).toMatchObject({ runId: a.runId, existing: true });
    await expect(analysis(ctx.editor, item.id)).rejects.toThrow(/כבר פעיל/);
    expect(await db.inventoryAnalysis.count({ where: { inventoryItemId: item.id } })).toBe(1);
  });

  it("uploads or image processing still running, or an active capture session, block it even when the status says COMPLETED", async () => {
    const { item } = await createBook(ctx.editor, { title: "העלאה בעיצומה" });
    await setPhoto(item.id, "COMPLETED");
    const pending = await addAsset(item.id, { upload: "UPLOADING" });
    expect(await photoReadiness(item.id)).toMatchObject({ ready: false, code: "UPLOADS_PENDING" });
    await expect(analysis(ctx.editor, item.id)).rejects.toThrow(/עדיין לא הועלו/);
    await db.photoFile.updateMany({ where: { assetId: pending.id }, data: { uploadStatus: "VERIFIED" } });

    await db.photoAsset.update({ where: { id: pending.id }, data: { imageState: "PREVIEW_READY" } });
    expect(await photoReadiness(item.id)).toMatchObject({ ready: false, code: "PROCESSING_PENDING" });
    await expect(analysis(ctx.editor, item.id)).rejects.toThrow(/עיבוד/);
    await db.photoAsset.update({ where: { id: pending.id }, data: { imageState: "DONE" } });
    expect((await photoReadiness(item.id)).ready).toBe(true);

    const session = await db.captureSession.create({ data: { organizationId: ctx.org.id, userId: ctx.photographer.userId, cameraKind: "SIMULATOR", inventoryItemId: item.id, activeCategory: "COVER" } });
    expect(await photoReadiness(item.id)).toMatchObject({ ready: false, code: "CAPTURE_SESSION_ACTIVE" });
    await db.captureSession.update({ where: { id: session.id }, data: { status: "ENDED", endedAt: new Date() } });
    expect((await photoReadiness(item.id)).ready).toBe(true);
    // a photo that was deleted does not block
    const gone = await addAsset(item.id, { upload: "FAILED" });
    await db.photoAsset.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect((await photoReadiness(item.id)).ready).toBe(true);
  });

  it("photography re-opened after the run was queued: the worker fails the run, no photo reaches the model, nothing is charged", async () => {
    const { item } = await createBook(ctx.editor, { title: "נפתח מחדש" });
    await setPhoto(item.id, "COMPLETED");
    await addAsset(item.id);
    const queued = await analysis(ctx.editor, item.id);
    await setPhoto(item.id, "IN_PROGRESS");
    await runAnalysis(queued.runId).catch(() => undefined);
    const run = await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: queued.runId } });
    expect(run.status).toBe("FAILED");
    expect(run.error).toContain(PHOTO_GATE_MESSAGE);
    expect(run.inputTokens ?? 0).toBe(0);
    expect(run.costUsd).toBeNull();
    expect(provider.requests).toHaveLength(0);
    expect(await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ aiStatus: "FAILED" });
  });

  it("an analysed book sent back to photography keeps its result and history; a re-analysis (even with a manager's password) waits for the photography", async () => {
    const { item } = await createBook(ctx.editor, { title: "חזר לצילום", catalogHeadline: "כותרת ששמורה" });
    await db.inventoryItem.update({ where: { id: item.id }, data: { aiStatus: "COMPLETED", aiCompletedAt: new Date(), photoStatus: "NEEDS_RESHOOT" } });
    const old = await db.inventoryAnalysis.create({ data: { organizationId: ctx.org.id, inventoryItemId: item.id, kind: "catalog_ai", status: "COMPLETED", requestKey: randomUUID(), createdById: ctx.editor.userId } });
    await expect(requestAnalysis(ctx.editor, item.id, { requestKey: randomUUID(), approval: { email: ctx.admin.email, password: "whatever" } })).rejects.toThrow(PHOTO_GATE_MESSAGE);
    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ aiStatus: "COMPLETED", catalogHeadline: "כותרת ששמורה" });
    expect(after.aiCompletedAt).not.toBeNull();
    expect(await db.inventoryAnalysis.findUnique({ where: { id: old.id } })).not.toBeNull();
    // manual editing of the existing text is never blocked by the photography state
    await expect(updateItem(ctx.editor, item.id, { catalogDescription: "תיאור שנערך ידנית" })).resolves.toBeTruthy();
  });


  /* ───────────── automatic first analysis after "סיום פריט" ───────────── */

  const finish = (itemId: string, status: "COMPLETED" | "PENDING_REVIEW" | "NEEDS_RESHOOT" = "COMPLETED", opId: string = randomUUID(), user = ctx.photographer) => finishCapture(user, itemId, { status, opId });
  const runsOf = (itemId: string) => db.inventoryAnalysis.findMany({ where: { inventoryItemId: itemId, kind: "catalog_ai" } });

  it("finish with photos and no earlier analysis queues ONE background run, marked automatic, without calling the model; a double click or a second finish adds nothing", async () => {
    const { item } = await createBook(ctx.editor, { title: "סיום אוטומטי" });
    await addAsset(item.id);
    const key = randomUUID();
    const [a, b] = await Promise.all([finish(item.id, "COMPLETED", key), finish(item.id, "COMPLETED", key)]);
    expect([a.ai.started, b.ai.started].filter(Boolean)).toHaveLength(1);
    const runs = await runsOf(item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "QUEUED", createdById: ctx.photographer.userId });
    expect(runs[0]!.input).toMatchObject({ auto: true, trigger: "capture-finish" });
    expect(await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ aiStatus: "QUEUED", photoStatus: "COMPLETED" });
    expect((await db.auditLog.findFirstOrThrow({ where: { inventoryItemId: item.id, action: "ai.requested" } })).data).toMatchObject({ auto: true });
    // finishing again (another person, a new click) never adds a run while one is queued
    const again = await finish(item.id, "COMPLETED", randomUUID(), ctx.editor);
    expect(again.ai.started).toBe(false);
    expect(await runsOf(item.id)).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
  });

  it("no photos, or a finish that is not COMPLETED: no run, no job, nothing charged; the finish itself still works", async () => {
    const { item } = await createBook(ctx.editor, { title: "ללא תמונות" });
    const r = await finish(item.id);
    expect(r).toMatchObject({ status: "COMPLETED", ai: { started: false, reason: "אין תמונות לספר" } });
    expect(await runsOf(item.id)).toHaveLength(0);
    const { item: other } = await createBook(ctx.editor, { title: "ממתין לבדיקה" });
    await addAsset(other.id);
    expect((await finish(other.id, "PENDING_REVIEW")).ai.started).toBe(false);
    expect((await finish(other.id, "NEEDS_RESHOOT")).ai.started).toBe(false);
    expect(await runsOf(other.id)).toHaveLength(0);
    // photos added later and a proper finish: now the first analysis starts
    expect((await finish(other.id, "COMPLETED")).ai.started).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });

  it("an analysed book never gets another automatic analysis - not after more photos and a new finish; a failed automatic run is not repeated by finishing again", async () => {
    const { item } = await createBook(ctx.editor, { title: "כבר נותח" });
    await addAsset(item.id);
    await db.inventoryItem.update({ where: { id: item.id }, data: { aiStatus: "COMPLETED", aiCompletedAt: new Date() } });
    await db.inventoryAnalysis.create({ data: { organizationId: ctx.org.id, inventoryItemId: item.id, kind: "catalog_ai", status: "COMPLETED", requestKey: randomUUID() } });
    await addAsset(item.id); // two more photos later
    await addAsset(item.id);
    const r = await finish(item.id);
    expect(r.ai.started).toBe(false);
    expect(await runsOf(item.id)).toHaveLength(1);

    // an automatic run that failed: finishing again does not start another (a person retries with the AI button)
    const { item: failed } = await createBook(ctx.editor, { title: "נכשל אוטומטית" });
    await addAsset(failed.id);
    const first = await finish(failed.id);
    expect(first.ai.started).toBe(true);
    await db.inventoryAnalysis.updateMany({ where: { inventoryItemId: failed.id }, data: { status: "FAILED", error: "x" } });
    await db.inventoryItem.update({ where: { id: failed.id }, data: { aiStatus: "FAILED" } });
    for (let i = 0; i < 3; i++) expect((await finish(failed.id)).ai.started).toBe(false);
    expect(await runsOf(failed.id)).toHaveLength(1);
    // the manual button still works (new key) once photography is complete
    await expect(requestAnalysis(ctx.editor, failed.id, { requestKey: randomUUID() })).resolves.toMatchObject({ existing: false });
  });

  it("photos still uploading or processing: the run waits in the queue (the model is not called); an open capture session does not hold it; after too long it is closed as failed", async () => {
    const { item } = await createBook(ctx.editor, { title: "העלאה מאוחרת" });
    const asset = await addAsset(item.id, { upload: "UPLOADING" });
    await db.captureSession.create({ data: { organizationId: ctx.org.id, userId: ctx.photographer.userId, cameraKind: "SIMULATOR", inventoryItemId: item.id, activeCategory: "COVER" } });
    expect((await finish(item.id)).ai.started).toBe(true);
    const [run] = await runsOf(item.id);
    await expect(runAnalysis(run!.id)).rejects.toBeInstanceOf(AiDeferred);
    expect(await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({ status: "QUEUED" });
    expect(await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ aiStatus: "QUEUED" });
    expect(provider.requests).toHaveLength(0);
    // processing finished meanwhile is not enough while an upload is open; the wait is bounded
    await db.photoFile.updateMany({ where: { assetId: asset.id }, data: { uploadStatus: "FAILED" } });
    await db.inventoryAnalysis.update({ where: { id: run!.id }, data: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } });
    await runAnalysis(run!.id).catch(() => undefined);
    expect(await db.inventoryAnalysis.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({ status: "FAILED" });
    expect(provider.requests).toHaveLength(0);
  });

  /* ───────────── section 3: review notes ───────────── */

  it("notes: add, list, handle with a conclusion, reopen; never deleted; audited with who and when", async () => {
    expect(can("PHOTOGRAPHER", "reviewNote.add")).toBe(true);
    expect(can("PHOTOGRAPHER", "reviewNote.resolve")).toBe(false);
    expect(can("VIEWER", "reviewNote.add")).toBe(false);
    expect(can("EDITOR", "reviewNote.resolve")).toBe(true);
    const { item } = await createBook(ctx.editor, { title: "ספר עם הערות" });
    const n1 = await addReviewNote(ctx.photographer, item.id, { text: "לבדוק אם החתימה היא של רבי פלוני" });
    const n2 = await addReviewNote(ctx.editor, item.id, { text: "ייתכן שהמהדורה נדירה יותר" });
    expect(n1).toMatchObject({ status: "OPEN", createdBy: "PHOTOGRAPHER", resolvedBy: null });
    expect((await openNoteCounts(ctx.org.id, [item.id])).get(item.id)).toBe(2);

    // a photographer may edit an open note but not handle it
    await expect(updateReviewNote(ctx.photographer, n1.id, { status: "VERIFIED", expectedStatus: "OPEN" })).rejects.toThrow(/הרשאה/);
    expect(await updateReviewNote(ctx.photographer, n1.id, { text: "לבדוק אם החתימה היא של רבי משה", expectedStatus: "OPEN" })).toMatchObject({ text: "לבדוק אם החתימה היא של רבי משה" });

    const done = await updateReviewNote(ctx.editor, n1.id, { status: "VERIFIED", conclusion: "אומת מול ספר החתימות", expectedStatus: "OPEN" });
    expect(done).toMatchObject({ status: "VERIFIED", conclusion: "אומת מול ספר החתימות", resolvedBy: "EDITOR" });
    expect(done.resolvedAt).not.toBeNull();
    // a handled note is kept as it is: its text cannot be edited until it is reopened
    await expect(updateReviewNote(ctx.editor, n1.id, { text: "שינוי", expectedStatus: "VERIFIED" })).rejects.toThrow(/שטופלה/);
    expect((await openNoteCounts(ctx.org.id, [item.id])).get(item.id)).toBe(1);
    const notVerified = await updateReviewNote(ctx.editor, n2.id, { status: "NOT_VERIFIED", conclusion: "לא נמצא מקור", expectedStatus: "OPEN" });
    expect(notVerified.status).toBe("NOT_VERIFIED");
    expect((await openNoteCounts(ctx.org.id, [item.id])).get(item.id)).toBeUndefined();
    const reopened = await updateReviewNote(ctx.editor, n2.id, { status: "OPEN", expectedStatus: "NOT_VERIFIED" });
    expect(reopened).toMatchObject({ status: "OPEN", conclusion: null, resolvedBy: null });

    const notes = (await listReviewNotes(ctx.org.id, [item.id])).get(item.id)!;
    expect(notes).toHaveLength(2); // nothing deleted
    expect(notes[0]!.status).toBe("OPEN"); // open ones first
    const actions = (await db.auditLog.findMany({ where: { inventoryItemId: item.id, action: { startsWith: "review_note." } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["review_note.added", "review_note.added", "review_note.edited", "review_note.verified", "review_note.not_verified", "review_note.reopened"]);
  });

  it("two people handling the same note: the second is refused, nothing is overwritten silently", async () => {
    const { item } = await createBook(ctx.editor, { title: "טיפול כפול" });
    const n = await addReviewNote(ctx.editor, item.id, { text: "לברר את ההקדשה" });
    await updateReviewNote(ctx.editor, n.id, { status: "VERIFIED", conclusion: "אומת", expectedStatus: "OPEN" });
    await expect(updateReviewNote(ctx.admin, n.id, { status: "NOT_VERIFIED", conclusion: "לא אומת", expectedStatus: "OPEN" })).rejects.toThrow(/כבר עודכנה/);
    expect(await db.itemReviewNote.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ status: "VERIFIED", conclusion: "אומת" });
  });

  it("notes belong to the book: the same list from the inventory and from its lot, per book in a combined lot, none from another organization", async () => {
    const other = await makeOrg("workspace-other");
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `WS-${Date.now()}`, name: "הערות" });
    const { item: a } = await createBook(ctx.editor, { title: "ספר א" });
    const { item: b } = await createBook(ctx.editor, { title: "ספר ב" });
    await assignToCatalog(ctx.editor, a.id, { catalogId: catalog.id });
    await assignToCatalog(ctx.editor, b.id, { catalogId: catalog.id });
    await addReviewNote(ctx.editor, a.id, { text: "הערה של א" });
    await addReviewNote(ctx.editor, b.id, { text: "הערה של ב" });
    const byBook = await listReviewNotes(ctx.org.id, [a.id, b.id]);
    expect(byBook.get(a.id)!.map((n) => n.text)).toEqual(["הערה של א"]);
    expect(byBook.get(b.id)!.map((n) => n.text)).toEqual(["הערה של ב"]);
    expect((await listReviewNotes(other.org.id, [a.id])).get(a.id)).toEqual([]);
    await expect(addReviewNote(other.editor, a.id, { text: "זר" })).rejects.toThrow(/לא נמצא/);
    // the shared poll's stamp moves when a note is added or handled
    const s1 = await noteStamp(ctx.org.id, a.id);
    const note = byBook.get(a.id)![0]!;
    await new Promise((r) => setTimeout(r, 15));
    await updateReviewNote(ctx.editor, note.id, { status: "VERIFIED", expectedStatus: "OPEN" });
    const s2 = await noteStamp(ctx.org.id, a.id);
    expect(s1.open).toBe(1);
    expect(s2.open).toBe(0);
    expect(s2.rev).toBeGreaterThan(s1.rev);
  });

  /* ───────────── section 2: book ⇄ lot text ───────────── */

  async function lotOf(title: string, opts: { headline?: string; description?: string } = {}) {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `WSL-${Date.now()}-${Math.floor(Math.random() * 1e4)}`, name: "סנכרון" });
    const { item } = await createBook(ctx.editor, { title, catalogHeadline: opts.headline, catalogDescription: opts.description });
    const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id });
    return { item, lot, catalog };
  }
  const lotNow = (id: string) => db.lot.findUniqueOrThrow({ where: { id }, include: { descriptionVersions: { orderBy: { version: "asc" } } } });

  it("a person's edit of the book's catalog text reaches its ordinary lot (with a version); bold follows; the history keeps the earlier text", async () => {
    const { item, lot } = await lotOf("סנכרון מהספר", { headline: "כותרת ראשונה", description: "תיאור ראשון" });
    expect(draftComparison({ catalogHeadline: "כותרת ראשונה", catalogDescription: "תיאור ראשון" }, await lotNow(lot.id)).synced).toBe(true);
    await updateItem(ctx.editor, item.id, { catalogHeadline: "כותרת חדשה", catalogDescription: "תיאור חדש עם הדגשה", textFormat: { catalogDescription: [{ t: "תיאור חדש עם " }, { t: "הדגשה", b: true }] } });
    const l = await lotNow(lot.id);
    expect(l).toMatchObject({ shortDescription: "כותרת חדשה", description: "תיאור חדש עם הדגשה" });
    expect(l.textFormat).toMatchObject({ description: [{ t: "תיאור חדש עם " }, { t: "הדגשה", b: true }] });
    expect(l.descriptionVersions.map((v) => [v.description, v.source])).toEqual([["תיאור ראשון", "MANUAL"], ["תיאור חדש עם הדגשה", "MANUAL"]]);
    // bold added to the same text: only the formatting moves
    await updateItem(ctx.editor, item.id, { textFormat: { catalogDescription: [{ t: "תיאור ", b: true }, { t: "חדש עם הדגשה" }] } });
    expect((await lotNow(lot.id)).textFormat).toMatchObject({ description: [{ t: "תיאור ", b: true }, { t: "חדש עם הדגשה" }] });
  });

  it("a text written on purpose for the catalog is never overwritten by the book (dedicated); the difference is reported; an AI-sourced edit follows the same rule", async () => {
    const { item, lot } = await lotOf("תיאור ייעודי", { headline: "כותרת ספר", description: "תיאור ספר" });
    await updateLot(ctx.editor, lot.id, { description: "תיאור שנכתב במיוחד לקטלוג" });
    expect((await lotNow(lot.id)).description).toBe("תיאור שנכתב במיוחד לקטלוג");
    await updateItem(ctx.editor, item.id, { catalogDescription: "תיאור ספר מעודכן", catalogHeadline: "כותרת ספר מעודכנת" }, { source: "ai" });
    const l = await lotNow(lot.id);
    expect(l.description).toBe("תיאור שנכתב במיוחד לקטלוג"); // untouched
    expect(l.shortDescription).toBe("כותרת ספר מעודכנת"); // the headline had not been customised: it follows
    const cmp = draftComparison({ catalogHeadline: "כותרת ספר מעודכנת", catalogDescription: "תיאור ספר מעודכן" }, l);
    expect(cmp).toMatchObject({ headline: true, description: false, synced: false });
  });

  it("an offered lot is public material: the book's edits never change it", async () => {
    const { item, lot } = await lotOf("הוצע", { headline: "כותרת", description: "תיאור" });
    await db.lot.update({ where: { id: lot.id }, data: { commercialStatus: "OFFERED" } });
    await updateItem(ctx.editor, item.id, { catalogDescription: "תיאור חדש" });
    expect((await lotNow(lot.id)).description).toBe("תיאור");
  });

  it("explicit resolution, both ways: versioned, audited, refused when either side changed meanwhile", async () => {
    const { item, lot } = await lotOf("הכרעה", { headline: "כותרת ספר", description: "תיאור ספר" });
    await updateLot(ctx.editor, lot.id, { description: "נוסח הקטלוג" });
    let l = await lotNow(lot.id);
    const itemVersion = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    const lotVersion = l.descriptionVersions.at(-1)!.version;

    await expect(resolveCatalogDraft(ctx.editor, lot.id, { direction: "book_to_lot", expectedItemVersion: itemVersion + 1, expectedLotVersion: lotVersion })).rejects.toThrow(/עודכנו בינתיים/);
    await resolveCatalogDraft(ctx.editor, lot.id, { direction: "book_to_lot", expectedItemVersion: itemVersion, expectedLotVersion: lotVersion });
    l = await lotNow(lot.id);
    expect(l.description).toBe("תיאור ספר");
    expect(l.descriptionVersions.at(-1)).toMatchObject({ description: "תיאור ספר", version: lotVersion + 1 });
    expect(l.descriptionVersions.some((v) => v.description === "נוסח הקטלוג")).toBe(true); // the dedicated text stays in the lot's versions

    await updateLot(ctx.editor, lot.id, { description: "נוסח שני לקטלוג" });
    const l2 = await lotNow(lot.id);
    const it2 = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    await resolveCatalogDraft(ctx.editor, lot.id, { direction: "lot_to_book", expectedItemVersion: it2.detailsVersion, expectedLotVersion: l2.descriptionVersions.at(-1)!.version });
    const it3 = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it3.catalogDescription).toBe("נוסח שני לקטלוג");
    expect(it3.detailsVersion).toBeGreaterThan(it2.detailsVersion);
    expect(draftComparison(it3, await lotNow(lot.id)).synced).toBe(true);
    const actions = (await db.auditLog.findMany({ where: { lotId: lot.id, action: { startsWith: "lot.draft_" } } })).map((a) => a.action).sort();
    expect(actions).toEqual(["lot.draft_to_book", "lot.draft_to_lot"]);
  });

  it("a combined lot keeps its shared description: one book's edit never writes into it, and the books keep their own notes", async () => {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `WSC-${Date.now()}`, name: "משולב" });
    const { item: a } = await createBook(ctx.editor, { title: "משולב א", catalogDescription: "תיאור א" });
    const { item: b } = await createBook(ctx.editor, { title: "משולב ב", catalogDescription: "תיאור ב" });
    const la = await assignToCatalog(ctx.editor, a.id, { catalogId: catalog.id });
    const lb = await assignToCatalog(ctx.editor, b.id, { catalogId: catalog.id });
    const { mergeLots } = await import("@/server/services/lot-members");
    await mergeLots(ctx.editor, { catalogId: catalog.id, lotIds: [la.id, lb.id], keepLotId: la.id, title: "אוסף" });
    await updateLot(ctx.editor, la.id, { description: "תיאור משותף של הלוט" });
    await updateItem(ctx.editor, a.id, { catalogDescription: "תיאור א מעודכן" });
    // the lot's own shared text, and its versions, are untouched
    const shared = await lotNow(la.id);
    expect(shared.description).toBe("תיאור משותף של הלוט");
    expect(shared.descriptionVersions.every((v) => v.description !== "תיאור א מעודכן")).toBe(true);
    // and the books never share notes

    await addReviewNote(ctx.editor, a.id, { text: "רק לספר א" });
    expect((await openNoteCounts(ctx.org.id, [a.id, b.id])).get(b.id)).toBeUndefined();
    await expect(resolveCatalogDraft(ctx.editor, la.id, { direction: "book_to_lot", expectedItemVersion: 0, expectedLotVersion: 0 })).rejects.toThrow(/משולב/);
  });
});
