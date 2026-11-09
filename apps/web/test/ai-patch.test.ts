import { describe, expect, it } from "vitest";
import { applyOps, type FieldValues, type Op } from "@/server/ai/patch";
import { extraReviewNotes } from "@/server/ai/mapper";
import { ANALYSIS_JSON_SCHEMA, REWRITE_FIELDS, REWRITE_PATCH_JSON_SCHEMA, analysisResultZ, type AnalysisResult } from "@/server/ai/schema";
import { reasoningOptions } from "@/server/ai/settings";
import { CODE_RULES, DEFAULT_ANALYSIS_PROMPT, DEFAULT_MANUSCRIPT_PROMPT, composeInstructions, SYSTEM_PROMPT } from "@/server/ai/catalog-prompt";
import { hasForbiddenDash } from "@/server/ai/text";
import { GeminiProvider, toOpenApiSchema } from "@/server/ai/providers/gemini";

const base = (over: Partial<FieldValues> = {}): FieldValues => ({
  title: "ספר לדוגמה",
  subtitle: null,
  author: "רבי יוסף",
  printPlace: "לבוב",
  printYear: "תקנ\"ט [1799]",
  publisher: null,
  edition: null,
  bibliographicNotes: "פרט ביבליוגרפי.",
  conditionNotes: "כתמים.",
  catalogHeadline: "ספר לדוגמה - לבוב",
  catalogDescription: "ספר לדוגמה, מאת רבי יוסף. לבוב, תקנ\"ט [1799].\n\nתוכן החיבור.\n\nמצב: כתמים.",
  ...over,
});
const op = (o: Partial<Op> & Pick<Op, "field" | "op">): Op => ({ target: null, anchor: null, content: null, reason: null, ...o });

describe("targeted rewrite: applying operations to the saved text", () => {
  it("returns only the fields that changed; everything else is not returned", () => {
    const r = applyOps(base(), [op({ field: "author", op: "replace", content: "רבי יוסף קולון" })]);
    expect(Object.keys(r.fields)).toEqual(["author"]);
    expect(r.fields.author).toBe("רבי יוסף קולון");
  });

  it("add with an anchor at the end of a paragraph makes a new paragraph; the rest of the text is byte-identical", () => {
    const cur = base();
    const r = applyOps(cur, [op({ field: "catalogDescription", op: "add", anchor: "תוכן החיבור.", content: "בשער חתימת בעלים." })]);
    expect(r.fields.catalogDescription).toBe("ספר לדוגמה, מאת רבי יוסף. לבוב, תקנ\"ט [1799].\n\nתוכן החיבור.\n\nבשער חתימת בעלים.\n\nמצב: כתמים.");
    expect(r.fields.catalogDescription!.startsWith(cur.catalogDescription!.slice(0, 60))).toBe(true);
  });

  it("add without an anchor goes before the condition paragraph; mid-paragraph anchors insert inline", () => {
    const r = applyOps(base(), [op({ field: "catalogDescription", op: "add", content: "הערה חדשה." })]);
    expect(r.fields.catalogDescription).toBe("ספר לדוגמה, מאת רבי יוסף. לבוב, תקנ\"ט [1799].\n\nתוכן החיבור.\n\nהערה חדשה.\n\nמצב: כתמים.");
    const inline = applyOps(base(), [op({ field: "catalogDescription", op: "add", anchor: "מאת רבי יוסף.", content: "בהסכמת הרב." })]);
    expect(inline.fields.catalogDescription).toContain("מאת רבי יוסף. בהסכמת הרב. לבוב, תקנ\"ט [1799].");
  });

  it("replace verifies the target against the current text (all mentions of a changed fact), and skips what it cannot find", () => {
    const r = applyOps(base(), [
      op({ field: "catalogDescription", op: "replace", target: "תקנ\"ט [1799]", content: "תקס\"א [1801]" }),
      op({ field: "conditionNotes", op: "replace", target: "לא קיים", content: "x" }),
      op({ field: "catalogDescription", op: "replace", content: "x" }), // a long field needs a target
      op({ field: "author", op: "delete", target: "" }),
    ]);
    expect(r.fields.catalogDescription).toContain("לבוב, תקס\"א [1801].");
    expect(r.fields.conditionNotes).toBeUndefined();
    expect(r.skipped.map((s) => s.field)).toEqual(["conditionNotes", "catalogDescription", "author"]);
    expect(r.applied).toHaveLength(1);
  });

  it("delete removes the exact text and tidies the spacing; an add of something already there is skipped", () => {
    const r = applyOps(base({ conditionNotes: "כתמים. בלאי. קרעים." }), [op({ field: "conditionNotes", op: "delete", target: " בלאי." }), op({ field: "bibliographicNotes", op: "add", content: "פרט ביבליוגרפי." })]);
    expect(r.fields.conditionNotes).toBe("כתמים. קרעים.");
    expect(r.skipped).toEqual([{ field: "bibliographicNotes", op: "add", reason: "הפרט כבר מופיע בשדה" }]);
  });

  it("inserted text is cleaned like every AI text: plain hyphen, no image ids, no sizes or page counts", () => {
    const r = applyOps(base(), [op({ field: "catalogDescription", op: "add", content: "חתימה — של רבי משה (img-03). 22 ס\"מ." })]);
    expect(r.fields.catalogDescription).toContain("חתימה - של רבי משה.");
    expect(r.fields.catalogDescription).not.toMatch(/img-|ס"מ|—/);
    // a short field with no value: add sets it
    expect(applyOps(base(), [op({ field: "publisher", op: "add", content: "אברהם שלום" })]).fields.publisher).toBe("אברהם שלום");
  });

  it("an empty operation list changes nothing", () => {
    expect(applyOps(base(), [])).toEqual({ fields: {}, applied: [], skipped: [] });
  });
});

describe("main feature, manuscript analysis and settings rules", () => {
  const answer = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
    itemType: { value: "MANUSCRIPT", confidence: "high", note: null },
    identification: { summary: "כתב יד", existingTitleCheck: "cannot_check", conflicts: [] },
    manuscriptAnalysis: { isManuscript: true, kind: "scribal_copy", attributionLevel: "text_by_author_scribe_unknown", transcription: "[לא קריא]", unreadable: ["img-02, שורות תחתונות"], writersCount: 1, confidence: "medium", notes: null },
    fields: Object.fromEntries(["title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "extent", "bibliographicNotes", "conditionNotes"].map((k) => [k, { status: "unknown", value: null, confidence: null, source: null, imageIds: [], note: null }])) as unknown as AnalysisResult["fields"],
    findings: [],
    catalogHighlight: { status: "found", mainFeature: "חידושי תורה", reason: "תוכן", evidence: "img-01", confidence: "medium", verified: false, secondaryFeatures: [] },
    catalog: { headline: "חידושי תורה בעצם כתב ידו של רבי פלוני", description: "כתב יד.", confidence: "medium" },
    imagesReviewed: [],
    requiresReview: [],
    warnings: [],
    ...over,
  });

  it("the answer schema carries catalogHighlight and manuscriptAnalysis (strict: every property required), the highlight before the catalog text", () => {
    const props = Object.keys(ANALYSIS_JSON_SCHEMA.properties);
    expect(props.indexOf("catalogHighlight")).toBeGreaterThan(props.indexOf("findings"));
    expect(props.indexOf("catalogHighlight")).toBeLessThan(props.indexOf("catalog"));
    expect(props.indexOf("manuscriptAnalysis")).toBeLessThan(props.indexOf("fields"));
    const strict = (s: { type?: unknown; required?: readonly string[]; properties?: Record<string, unknown>; additionalProperties?: unknown; items?: unknown }): void => {
      if (s.properties) {
        expect(s.additionalProperties).toBe(false);
        expect([...(s.required ?? [])].sort()).toEqual(Object.keys(s.properties).sort());
        for (const v of Object.values(s.properties)) strict(v as typeof s);
      }
      if (s.items) strict(s.items as typeof s);
    };
    strict(ANALYSIS_JSON_SCHEMA as never);
    strict(REWRITE_PATCH_JSON_SCHEMA as never);
    // results saved before the feature existed still parse
    const { catalogHighlight: _h, manuscriptAnalysis: _m, ...old } = answer();
    expect(analysisResultZ.safeParse(old).success).toBe(true);
    expect(analysisResultZ.safeParse(answer()).success).toBe(true);
    // Gemini's schema converter accepts the nullable integer / boolean pieces
    expect(() => toOpenApiSchema(ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>)).not.toThrow();
    expect(REWRITE_FIELDS).toContain("catalogDescription");
    expect(new GeminiProvider("gemini-3.8-flash", "k", "https://x", "low").model).toBe("gemini-3.8-flash");
  });

  it("an unverified main feature and an autograph claim without autograph-level evidence are flagged for the reviewer", () => {
    const notes = extraReviewNotes(answer());
    expect(notes.some((n) => n.field === "catalogHighlight" && n.reason.includes("אינו מאומת"))).toBe(true);
    expect(notes.some((n) => n.field === "manuscriptAnalysis" && n.reason.includes("אוטוגרף"))).toBe(true);
    expect(notes.some((n) => n.reason.includes("לא נקראו היטב"))).toBe(true);
    // a verified feature and a certain autograph: nothing to flag
    const ok = answer({ catalogHighlight: { status: "found", mainFeature: "הקדשה", reason: "r", evidence: "e", confidence: "high", verified: true, secondaryFeatures: [] }, manuscriptAnalysis: { isManuscript: true, kind: "autograph", attributionLevel: "autograph_certain", transcription: "t", unreadable: [], writersCount: 1, confidence: "high", notes: null } });
    expect(extraReviewNotes(ok)).toEqual([]);
  });

  it("the prompt: the main-feature and manuscript rules exist, and the code rules are appended to ANY edited text", () => {
    for (const s of ["catalogHighlight", "התחל בו", "verified = false", "נדיר ביותר"]) expect(DEFAULT_ANALYSIS_PROMPT).toContain(s);
    for (const s of ["תמלול לפני פירוש", "autograph_certain", "text_by_author_scribe_unknown", "attributed", "unknown_author", "[לא קריא]"]) expect(DEFAULT_MANUSCRIPT_PROMPT).toContain(s);
    const edited = composeInstructions({ analysis: "טקסט אחר לגמרי", manuscript: "" });
    expect(edited.startsWith("טקסט אחר לגמרי")).toBe(true);
    expect(edited.endsWith(CODE_RULES)).toBe(true);
    expect(composeInstructions()).toBe(SYSTEM_PROMPT);
    for (const t of [DEFAULT_ANALYSIS_PROMPT, DEFAULT_MANUSCRIPT_PROMPT, CODE_RULES]) expect(hasForbiddenDash(t)).toBe(false);
  });

  it("reasoning levels per model: Gemini 3.5+ flash has no 'minimal'; Gemini 3 flash and OpenAI do", () => {
    expect(reasoningOptions("gemini", "gemini-3.8-flash")).toEqual(["low", "medium", "high"]);
    expect(reasoningOptions("gemini", "gemini-3.6-flash")).toEqual(["low", "medium", "high"]);
    expect(reasoningOptions("gemini", "gemini-3-flash-preview")).toContain("minimal");
    expect(reasoningOptions("gemini", "gemini-2.5-flash")).toEqual([]);
    expect(reasoningOptions("openai", "gpt-5.4")).toContain("none");
  });
});
