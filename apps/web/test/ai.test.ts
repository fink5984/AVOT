import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanAiText, hasForbiddenDash, normalizeDashes, sameText } from "@/server/ai/text";
import { estimateTokens, loadStyleLibrary } from "@/server/ai/style-examples";
import { ANALYSIS_JSON_SCHEMA, OBSERVATION_JSON_SCHEMA, analysisResultZ, parseAnswer, InvalidAnswerError, AI_FIELD_NAMES, type AnalysisResult } from "@/server/ai/schema";
import { AI_WRITABLE, mapResult, type AiValues } from "@/server/ai/mapper";
import { buildAnalysisText, buildInstructions, redactPersonal, type ItemContext } from "@/server/ai/prompt-builder";
import { SYSTEM_PROMPT } from "@/server/ai/catalog-prompt";
import { activeProvider, aiConfig } from "@/server/ai/config";
import { computeCost, priceFor } from "@/server/ai/pricing";
import { batchImages, type PreparedImage } from "@/server/ai/images";
import { GeminiProvider, toOpenApiSchema } from "@/server/ai/providers/gemini";
import { OpenAiProvider } from "@/server/ai/providers/openai";
import { ProviderError, type ProviderRequest } from "@/server/ai/providers/types";
import { createProvider } from "@/server/ai/providers";
import examplesFile from "@/server/ai/catalog-style-examples.json";

/* ───────────── fixtures ───────────── */

const field = (value: string | null, over: Partial<AnalysisResult["fields"]["title"]> = {}): AnalysisResult["fields"]["title"] => ({
  status: value ? "found" : "unknown",
  value,
  confidence: value ? "high" : null,
  source: value ? "image" : null,
  imageIds: value ? ["img-01"] : [],
  note: null,
  ...over,
});

function result(over: Partial<AnalysisResult> = {}, fields: Partial<AnalysisResult["fields"]> = {}): AnalysisResult {
  return {
    itemType: { value: "BOOK", confidence: "high", note: null },
    identification: { summary: "ספר", existingTitleCheck: "more_precise_available", conflicts: [] },
    fields: { ...(Object.fromEntries(AI_FIELD_NAMES.map((f) => [f, field(null)])) as AnalysisResult["fields"]), ...fields },
    catalog: { headline: "כותרת", description: "תיאור קטלוגי", confidence: "medium" },
    findings: [],
    imagesReviewed: [{ imageId: "img-01", shows: "שער", usable: true }],
    requiresReview: [],
    warnings: [],
    ...over,
  };
}

const empty: AiValues = Object.fromEntries(AI_WRITABLE.map((f) => [f, f === "itemType" ? "UNKNOWN" : null])) as AiValues;
const values = (over: Partial<AiValues>): AiValues => ({ ...empty, title: "שם זמני", ...over });
const ids = new Set(["img-01", "img-02"]);

/* ───────────── dashes ───────────── */

describe("dash rule (only U+002D in AI text)", () => {
  it("replaces em, en and look-alike dashes, keeps the Hebrew maqaf and normal hyphens", () => {
    expect(normalizeDashes("ספר — מהדורה – ראשונה ‒ ― − －")).toBe("ספר - מהדורה - ראשונה - - - -");
    expect(normalizeDashes("בית־הכנסת a-b")).toBe("בית־הכנסת a-b");
    expect(hasForbiddenDash("א—ב")).toBe(true);
    expect(hasForbiddenDash("א-ב")).toBe(false);
  });

  it("cleanAiText trims, collapses blank lines, clamps on a word boundary and never returns empty strings", () => {
    expect(cleanAiText("  a — b \r\n\r\n\r\n\r\nc  ", 100)).toBe("a - b\n\nc");
    expect(cleanAiText("   ", 10)).toBeNull();
    expect(cleanAiText(null, 10)).toBeNull();
    expect(cleanAiText("אחת שתיים שלוש", 9)).toBe("אחת");
    expect(sameText("a — b", "a - b")).toBe(true);
  });

  it("the prompt itself contains no forbidden dash (models imitate their instructions)", () => {
    expect(hasForbiddenDash(SYSTEM_PROMPT)).toBe(false);
    expect(hasForbiddenDash(loadStyleLibrary().block)).toBe(false);
  });
});

/* ───────────── style library ───────────── */

describe("style examples library", () => {
  it("the shipped file is valid and every active example is sent", () => {
    const lib = loadStyleLibrary();
    expect(lib.skipped).toEqual([]);
    expect(lib.examples.length).toBe(examplesFile.examples.filter((e) => e.active).length);
    expect(lib.examples.length).toBeGreaterThanOrEqual(8);
    expect(lib.version).toBe(examplesFile.version);
    expect(lib.hash).toMatch(/^[0-9a-f]{16}$/);
    for (const e of lib.examples) expect(lib.block).toContain(e.description.slice(0, 40));
    expect(buildInstructions(lib)).toContain("אין להעתיק מהן עובדות");
  });

  it("an empty or missing library is valid (no examples block)", () => {
    for (const raw of [{}, { examples: [] }, null, { version: "x", examples: "nope" }]) {
      const lib = loadStyleLibrary(raw);
      expect(lib.examples).toEqual([]);
      expect(lib.block).toBe("");
      expect(buildInstructions(lib)).toBe(SYSTEM_PROMPT);
    }
  });

  it("invalid and duplicate entries are reported (never dropped silently), inactive ones are not sent", () => {
    const lib = loadStyleLibrary({
      version: "t1",
      examples: [
        { id: "a", description: "תיאור א" },
        { id: "b" },
        { id: "a", description: "כפול" },
        { id: "c", description: "לא פעיל", active: false },
        { id: "d", description: "עם קלט", input: { title: "x" }, headline: "כותרת" },
      ],
    });
    expect(lib.examples.map((e) => e.id)).toEqual(["a", "d"]);
    expect(lib.skipped.map((s) => s.id)).toEqual(["b", "a"]);
    expect(lib.block).toContain("נתוני קלט");
  });

  it("the hash follows the content", () => {
    const a = loadStyleLibrary({ examples: [{ id: "a", description: "x" }] });
    const b = loadStyleLibrary({ examples: [{ id: "a", description: "y" }] });
    expect(a.hash).not.toBe(b.hash);
    expect(estimateTokens("abcdefghij")).toBe(4);
  });
});

/* ───────────── answer schema ───────────── */

describe("answer schema (one format for both providers)", () => {
  function assertStrict(s: unknown, path = "$"): void {
    if (!s || typeof s !== "object") return;
    const o = s as Record<string, unknown>;
    if (o.type === "object" || (Array.isArray(o.type) && o.type.includes("object"))) {
      expect(o.additionalProperties, `${path} additionalProperties`).toBe(false);
      expect([...(o.required as string[])].sort(), `${path} required`).toEqual(Object.keys(o.properties as object).sort());
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties") for (const [pk, pv] of Object.entries(v as object)) assertStrict(pv, `${path}.${pk}`);
      else if (k === "items") assertStrict(v, `${path}[]`);
    }
  }

  it("is valid for OpenAI strict mode: closed objects, every property required", () => {
    assertStrict(ANALYSIS_JSON_SCHEMA);
    assertStrict(OBSERVATION_JSON_SCHEMA);
  });

  it("distinguishes unknown / not checked / not applicable per field", () => {
    const f = (ANALYSIS_JSON_SCHEMA.properties.fields.properties.printPlace.properties.status as { enum: string[] }).enum;
    expect(f).toEqual(["found", "unknown", "not_checked", "not_applicable"]);
  });

  it("validates answers and rejects broken ones with a clear error", () => {
    const ok = result();
    expect(parseAnswer(JSON.stringify(ok), analysisResultZ)).toEqual(ok);
    expect(parseAnswer("```json\n" + JSON.stringify(ok) + "\n```", analysisResultZ)).toEqual(ok);
    expect(() => parseAnswer("{not json", analysisResultZ)).toThrow(InvalidAnswerError);
    expect(() => parseAnswer(JSON.stringify({ ...ok, itemType: { value: "SPACESHIP", confidence: "high", note: null } }), analysisResultZ)).toThrow(/סכמה/);
    const { fields: _f, ...missing } = ok;
    expect(() => parseAnswer(JSON.stringify(missing), analysisResultZ)).toThrow(InvalidAnswerError);
  });

  it("converts to Gemini's OpenAPI schema subset (nullable, no additionalProperties)", () => {
    const g = toOpenApiSchema(ANALYSIS_JSON_SCHEMA) as Record<string, any>;
    expect(g.additionalProperties).toBeUndefined();
    const title = g.properties.fields.properties.title.properties;
    expect(title.value).toMatchObject({ type: "string", nullable: true });
    expect(title.confidence.enum).toEqual(["high", "medium", "low"]);
    expect(g.propertyOrdering[0]).toBe("itemType");
  });
});

/* ───────────── result → item fields ───────────── */

describe("mapping the result to item fields", () => {
  it("fills empty fields and replaces the photographer's provisional title with the title-page reading", () => {
    const r = result({}, { title: field("ספר חובות הלבבות"), author: field("בחיי אבן פקודה"), printPlace: field("זולקווא") });
    const out = mapResult({ result: r, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch).toMatchObject({ title: "ספר חובות הלבבות", author: "בחיי אבן פקודה", printPlace: "זולקווא", itemType: "BOOK", catalogDescription: "תיאור קטלוגי" });
    expect(out.decisions.title).toMatchObject({ action: "written", replacedManual: true });
    expect(out.review.some((x) => x.field === "title" && x.reason.includes("שם זמני"))).toBe(true);
  });

  it("never replaces an existing value with null (unknown / not checked / not applicable)", () => {
    const r = result({}, { printYear: field(null, { status: "not_checked" }), printPlace: field(null, { status: "not_applicable" }), publisher: { ...field(null), status: "found", value: "  " } });
    const cur = values({ printYear: "תקע\"ב", printPlace: "לבוב", publisher: "דפוס X" });
    const out = mapResult({ result: r, current: cur, base: cur, previousAi: null, imageIds: ids, catalogIsManual: false });
    for (const f of ["printYear", "printPlace", "publisher"] as const) {
      expect(out.patch[f]).toBeUndefined();
      expect(out.decisions[f]?.action).toBe("kept");
    }
  });

  it("keeps a manual value against a low-confidence or non-visual proposal, and flags it", () => {
    const r = result({}, { author: field("ר' יוסף", { confidence: "low" }), printPlace: field("וילנא", { source: "general_knowledge", confidence: "medium" }) });
    const cur = values({ author: "ר' יעקב", printPlace: "ורשה" });
    const out = mapResult({ result: r, current: cur, base: cur, previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.author).toBeUndefined();
    expect(out.patch.printPlace).toBeUndefined();
    expect(out.review.filter((x) => x.field === "author" || x.field === "printPlace")).toHaveLength(2);
  });

  it("a value identified from knowledge (not read in the photos) is flagged for review even when the model says 'high'", () => {
    const r = result({}, { title: field("שומר אמונים", { source: "general_knowledge", confidence: "high" }), printYear: field("תקנ\"ח", { source: "image" }) });
    const out = mapResult({ result: r, current: values({ title: null }), base: values({ title: null }), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.title).toBe("שומר אמונים");
    expect(out.review.some((x) => x.field === "title" && x.reason.includes("לפי ידע כללי"))).toBe(true);
    expect(out.review.some((x) => x.field === "printYear")).toBe(false);
  });

  it("extent and sizes are never written by the AI: the extent field is left alone, page counts and cm are removed from the text", () => {
    const desc = "ספר ספרא. זיטאמיר, תרכ\"ו [1866].\n\nבדף השער חותמת. בראש כל דף נדפס שם הספר.\n\n239, [1] עמ'. 21 ס\"מ בקירוב. מצב בינוני. כתמים.";
    const r = result({ catalog: { headline: "ספרא", description: desc, confidence: "high" } }, { extent: field("239, [1] עמ'"), conditionNotes: field("[2], רלו דף. 46.5X31 ס\"מ. מצב טוב.") });
    const out = mapResult({ result: r, current: values({ extent: "קנב דף" }), base: values({ extent: "קנב דף" }), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.catalogDescription).toBe("ספר ספרא. זיטאמיר, תרכ\"ו [1866].\n\nבדף השער חותמת. בראש כל דף נדפס שם הספר.\n\nמצב בינוני. כתמים.");
    expect(out.patch).not.toHaveProperty("extent");
    expect(out.decisions.extent?.action).toBe("kept");
    expect(out.patch.conditionNotes).toBe("מצב טוב.");
    // labels left without their value go too
    const r2 = result({ catalog: { headline: "ח", description: "חותם: 2X1.5 ס\"מ בקירוב; גובה (כולל זיז): 4 ס\"מ. מצב כללי טוב.", confidence: "high" } });
    expect(mapResult({ result: r2, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false }).patch.catalogDescription).toBe("מצב כללי טוב.");
  });

  it("image ids never reach the catalog text", () => {
    const r = result({ catalog: { headline: "שפע טל (img-02)", description: "כולל תרשים (img-10).\n\nבכותרת ב-img-02-top נדפס השם, וגם img-03, img-04.", confidence: "medium" } });
    const out = mapResult({ result: r, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.catalogHeadline).toBe("שפע טל");
    expect(out.patch.catalogDescription).toBe("כולל תרשים.\n\nבכותרת נדפס השם, וגם.");
    expect(out.patch.catalogDescription).not.toMatch(/img-/);
  });

  it("re-analysis replaces the previous AI values, even with lower confidence", () => {
    const r = result({}, { printYear: field("תקפ\"ה", { confidence: "low" }) });
    const cur = values({ printYear: "תקפ\"ד" });
    const out = mapResult({ result: r, current: cur, base: cur, previousAi: { printYear: "תקפ\"ד" }, imageIds: ids, catalogIsManual: false });
    expect(out.patch.printYear).toBe("תקפ\"ה");
    expect(out.decisions.printYear).toMatchObject({ action: "written", replacedManual: false });
  });

  it("a field a person edited while the analysis ran is never overwritten", () => {
    const r = result({}, { author: field("AI author"), title: field("AI title") });
    const out = mapResult({ result: r, current: values({ author: "נערך עכשיו" }), base: values({ author: null }), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.author).toBeUndefined();
    expect(out.decisions.author?.action).toBe("skipped_human_edit");
    expect(out.patch.title).toBe("AI title"); // untouched fields still get the result
  });

  it("a catalog draft written by a person is never replaced", () => {
    const cur = values({ catalogDescription: "תיאור ידני", catalogHeadline: "כותרת ידנית" });
    const out = mapResult({ result: result(), current: cur, base: cur, previousAi: null, imageIds: ids, catalogIsManual: true });
    expect(out.patch.catalogDescription).toBeUndefined();
    expect(out.patch.catalogHeadline).toBeUndefined();
  });

  it("only AI-writable keys can appear in the patch (protected fields are out of reach)", () => {
    const r = result({}, { title: field("t"), conditionNotes: field("כתמים") });
    const out = mapResult({ result: r, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false });
    for (const k of Object.keys(out.patch)) expect(AI_WRITABLE).toContain(k);
    for (const k of ["barcode", "inventoryNumber", "consignorId", "currentLocationId", "photographerNotes", "internalNotes", "heightMm"]) expect(out.patch).not.toHaveProperty(k);
  });

  it("normalises dashes in written text, warns about image ids that were not sent", () => {
    const r = result({ findings: [{ kind: "signature", imageIds: ["img-99"], transcription: "חתימה — מקורית", reading: "probable", attribution: null, attributionBasis: null, significance: null }] }, { bibliographicNotes: field("חלק א — חלק ב", { imageIds: ["img-07"] }) });
    const out = mapResult({ result: r, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.patch.bibliographicNotes).toBe("חלק א - חלק ב");
    expect(out.warnings.join(" ")).toMatch(/img-07/);
    expect(out.warnings.join(" ")).toMatch(/img-99/);
    // the transcription (evidence) is not part of the patch and stays as the model gave it
    expect(r.findings[0]!.transcription).toBe("חתימה — מקורית");
  });

  it("the same review remark repeated by the model is listed once", () => {
    const r = result({ requiresReview: [{ field: "title", reason: "אין צילומים של השער." }, { field: "author", reason: "אין צילומים  של השער." }, { field: "printYear", reason: "שנה לא קריאה" }] });
    const out = mapResult({ result: r, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false });
    expect(out.review.filter((x) => x.reason.includes("אין צילומים"))).toHaveLength(1);
    expect(out.review.some((x) => x.reason === "שנה לא קריאה")).toBe(true);
  });

  it("item type: set when unknown, a person's choice kept unless the evidence is strong", () => {
    const poster = result({ itemType: { value: "POSTER", confidence: "medium", note: null } });
    expect(mapResult({ result: poster, current: values({}), base: values({}), previousAi: null, imageIds: ids, catalogIsManual: false }).patch.itemType).toBe("POSTER");
    const manual = values({ itemType: "DOCUMENT" });
    expect(mapResult({ result: poster, current: manual, base: manual, previousAi: null, imageIds: ids, catalogIsManual: false }).patch.itemType).toBeUndefined();
  });
});

/* ───────────── prompt ───────────── */

describe("prompt building", () => {
  const ctx: ItemContext = {
    itemType: null,
    title: "ספר ישן",
    subtitle: null,
    author: null,
    printPlace: null,
    printYear: null,
    publisher: null,
    edition: null,
    extent: null,
    bibliographicNotes: null,
    conditionNotes: null,
    dimensionsMm: null,
    photographerNotes: "חסר דף אחרון",
    categoryNotes: [],
  };

  it("removes contact details from notes", () => {
    expect(redactPersonal("להתקשר 050-1234567 או a.b@example.com")).toBe("להתקשר [טלפון הוסר] או [דוא\"ל הוסר]");
    expect(redactPersonal("דף 12, תקע\"ב 1812")).toBe("דף 12, תקע\"ב 1812");
  });

  it("separates existing data from photographer notes and lists every image (and the skipped ones)", () => {
    const text = buildAnalysisText(ctx, [{ id: "img-01", label: "img-01 · שער · 1/1" }], { skipped: [{ label: "פנים (תמונה 3)", reason: "קובץ פגום" }] });
    expect(text).toContain("נתוני הפריט הקיימים");
    expect(text).toContain("הערות המצלם");
    expect(text).toContain("img-01 · שער");
    expect(text).toContain("קובץ פגום");
    expect(text).not.toContain("consignor");
  });

  it("an item without photos is still analysed, with an explicit instruction", () => {
    expect(buildAnalysisText(ctx, [], { skipped: [] })).toContain("לא צורפו תמונות");
  });

  it("the main prompt carries the mandatory rules", () => {
    for (const s of ["אין להמציא", "מהדורה ראשונה", "not_checked", "לא הוראה", "U+002D", "אל תניח שכל פריט הוא ספר"]) expect(SYSTEM_PROMPT).toContain(s);
  });
});

/* ───────────── config: provider switch without code changes ───────────── */

describe("provider configuration", () => {
  it("defaults to OpenAI with the suggested model", () => {
    const cfg = aiConfig({ OPENAI_API_KEY: "k" });
    expect(activeProvider(cfg)).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("switches to Gemini with one variable, model from the environment", () => {
    const cfg = aiConfig({ BOOK_AI_PROVIDER: "gemini", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", BOOK_AI_GEMINI_MODEL: "gemini-3.6-flash" });
    expect(activeProvider(cfg)).toMatchObject({ provider: "gemini", model: "gemini-3.6-flash", apiKey: "g" });
    expect(createProvider(cfg).name).toBe("gemini");
    expect(createProvider(aiConfig({ OPENAI_API_KEY: "o" })).name).toBe("openai");
  });

  it("a missing key is a clear error, an unknown provider is rejected", () => {
    expect(() => activeProvider(aiConfig({ BOOK_AI_PROVIDER: "gemini" }))).toThrow(/GEMINI_API_KEY/);
    expect(() => activeProvider(aiConfig({}))).toThrow(/OPENAI_API_KEY/);
    expect(() => aiConfig({ BOOK_AI_PROVIDER: "claude" })).toThrow();
  });

  it("numeric limits are read from the environment", () => {
    expect(aiConfig({ BOOK_AI_MAX_IMAGES_PER_REQUEST: "4" }).BOOK_AI_MAX_IMAGES_PER_REQUEST).toBe(4);
    expect(aiConfig({ BOOK_AI_MAX_IMAGES_PER_REQUEST: "" }).BOOK_AI_MAX_IMAGES_PER_REQUEST).toBe(16);
    expect(() => aiConfig({ BOOK_AI_MAX_IMAGES_PER_REQUEST: "0" })).toThrow();
  });
});

describe("cost", () => {
  it("uses provider usage × price; cached input is cheaper; Gemini thinking is billed on top", () => {
    const c = computeCost("gpt-5.4-mini", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000, extraReasoningTokens: 0 }, { usageReported: true });
    expect(c.costUsd).toBeCloseTo(0.5 * 0.75 + 0.5 * 0.075 + 0.1 * 4.5, 6);
    expect(c.estimated).toBe(false);
    const g = computeCost("gemini-3-flash-preview", { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 10_000, extraReasoningTokens: 10_000 }, { usageReported: true });
    expect(g.costUsd).toBeCloseTo(0.1 * 0.5 + 0.02 * 3, 6);
  });

  it("unknown model or missing usage → no figure, marked as estimate; dated snapshots priced like the alias", () => {
    expect(computeCost("some-new-model", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, extraReasoningTokens: 0 }, { usageReported: true })).toMatchObject({ costUsd: null, estimated: true });
    expect(priceFor("gpt-5.4-mini-2026-03-17", undefined)?.input).toBe(0.75);
    expect(priceFor("x", '{"x":{"input":1,"output":2}}')?.output).toBe(2);
  });
});

describe("staged requests", () => {
  const img = (id: string, bytes: number, zoomOf: string | null = null) => ({ id, zoomOf, data: Buffer.alloc(bytes) }) as unknown as PreparedImage;
  it("splits by image count and bytes; a zoom always travels with its full image; nothing is lost", () => {
    const imgs = [img("img-01", 10), img("img-01-top", 10, "img-01"), img("img-01-bottom", 10, "img-01"), img("img-02", 10), img("img-03", 10), img("img-04", 50)];
    const b = batchImages(imgs, 3, 60);
    expect(b.flat().map((i) => i.id)).toEqual(imgs.map((i) => i.id));
    expect(b[0]!.map((i) => i.id)).toEqual(["img-01", "img-01-top", "img-01-bottom"]);
    for (const batch of b) expect(batch.reduce((s, i) => s + i.data.length, 0)).toBeLessThanOrEqual(60);
  });
});

/* ───────────── provider adapters (fetch mocked: no network) ───────────── */

describe("provider adapters", () => {
  afterEach(() => vi.unstubAllGlobals());
  const req: ProviderRequest = {
    instructions: "SYS",
    cacheKey: "ck",
    userText: "USER",
    images: [{ id: "img-01", label: "img-01 · שער", data: Buffer.from("jpg"), mime: "image/jpeg", detail: "high" }],
    schemaName: "item_analysis",
    schema: { type: "object" },
    maxOutputTokens: 100,
    timeoutMs: 5000,
  };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

  it("OpenAI: strict json_schema, no storage, labelled images, no tools; usage parsed", async () => {
    const fetchMock = vi.fn(async () =>
      reply(200, { status: "completed", model: "gpt-5.4-mini-2026-03-17", output: [{ type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } }, { "x-request-id": "req_1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await new OpenAiProvider("gpt-5.4-mini", "sk-test", "https://api.openai.com/v1").generate(req);
    expect(r).toMatchObject({ text: '{"a":1}', model: "gpt-5.4-mini-2026-03-17", requestId: "req_1", usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 300, reasoningTokens: 100, extraReasoningTokens: 0 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "item_analysis" });
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBe("SYS");
    expect(body.prompt_cache_key).toBe("ck");
    expect(body.input[0].content.map((c: { type: string }) => c.type)).toEqual(["input_text", "input_text", "input_image"]);
    expect(body.input[0].content[2].image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("OpenAI: title pages and zooms go with the configured detail ('original' by default), ordinary photos with auto", async () => {
    const two = { ...req, images: [req.images[0]!, { id: "img-02", label: "img-02 · פנים", data: Buffer.from("jpg"), mime: "image/jpeg" as const, detail: "auto" as const }] };
    const sent = async (p: OpenAiProvider) => {
      const fetchMock = vi.fn(async () => reply(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }));
      vi.stubGlobal("fetch", fetchMock);
      await p.generate(two);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      return body.input[0].content.filter((c: { type: string }) => c.type === "input_image").map((c: { detail: string }) => c.detail);
    };
    expect(await sent(createProvider(aiConfig({ OPENAI_API_KEY: "k" })) as OpenAiProvider)).toEqual(["original", "auto"]);
    expect(await sent(createProvider(aiConfig({ OPENAI_API_KEY: "k", BOOK_AI_OPENAI_DETAIL: "high" })) as OpenAiProvider)).toEqual(["high", "auto"]);
  });

  it("OpenAI: rate limit is retryable with Retry-After, quota and truncation are not", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, { error: { message: "Rate limit reached", type: "requests" } }, { "retry-after": "7" })));
    const e1 = await new OpenAiProvider("m", "k", "https://x").generate(req).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ kind: "rate_limit", retryable: true, opts: { retryAfterMs: 7000 } });
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } })));
    expect(await new OpenAiProvider("m", "k", "https://x").generate(req).catch((e) => e)).toMatchObject({ kind: "quota", retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })));
    expect(await new OpenAiProvider("m", "k", "https://x").generate(req).catch((e) => e)).toMatchObject({ kind: "truncated", retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => reply(500, "oops")));
    expect(await new OpenAiProvider("m", "k", "https://x").generate(req).catch((e) => e)).toMatchObject({ kind: "server", retryable: true });
  });

  it("Gemini: responseJsonSchema, key in header, thoughts excluded from text and billed separately", async () => {
    const fetchMock = vi.fn(async () =>
      reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: '{"b":2}' }] } }], usageMetadata: { promptTokenCount: 2000, cachedContentTokenCount: 1500, candidatesTokenCount: 400, thoughtsTokenCount: 250 }, modelVersion: "gemini-3-flash-preview", responseId: "r1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await new GeminiProvider("gemini-3-flash-preview", "g-key", "https://generativelanguage.googleapis.com/v1beta", "low").generate(req);
    expect(r).toMatchObject({ text: '{"b":2}', usage: { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 400, extraReasoningTokens: 250 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent");
    expect(url).not.toContain("g-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object" }, thinkingConfig: { thinkingLevel: "low" } });
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.contents[0].parts[2].inlineData.mimeType).toBe("image/jpeg");
    expect(body.tools).toBeUndefined();
  });

  it("Gemini: falls back to responseSchema once when responseJsonSchema is rejected; MAX_TOKENS and SAFETY are errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(400, { error: { message: "Invalid JSON payload received. Unknown name \"responseJsonSchema\"" } }))
      .mockResolvedValueOnce(reply(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new GeminiProvider("m", "k", "https://x").generate(req);
    expect(r.usage).toBeNull();
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).generationConfig.responseSchema).toBeDefined();
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }] })));
    expect(await new GeminiProvider("m", "k", "https://x").generate(req).catch((e) => e)).toMatchObject({ kind: "truncated" });
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { promptFeedback: { blockReason: "SAFETY" } })));
    expect(await new GeminiProvider("m", "k", "https://x").generate(req).catch((e) => e)).toMatchObject({ kind: "refused" });
  });

  it("a timeout becomes a retryable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))));
    const e = await new OpenAiProvider("m", "k", "https://x").generate({ ...req, timeoutMs: 30 }).catch((x) => x);
    expect(e).toMatchObject({ kind: "timeout", retryable: true });
  });
});
