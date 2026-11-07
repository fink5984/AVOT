import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { aiConfig, activeProvider } from "@/server/ai/config";
import { createProvider } from "@/server/ai/providers";
import { buildAnalysisText, buildInstructions, cacheKeyFor, type ItemContext } from "@/server/ai/prompt-builder";
import { loadStyleLibrary } from "@/server/ai/style-examples";
import { ANALYSIS_JSON_SCHEMA, analysisResultZ, parseAnswer } from "@/server/ai/schema";
import { AI_WRITABLE, mapResult, type AiValues } from "@/server/ai/mapper";
import { computeCost } from "@/server/ai/pricing";
import { hasForbiddenDash } from "@/server/ai/text";
import { labelFont } from "@/server/labels/bitmap";
import { PROMPT_VERSION } from "@/server/ai/catalog-prompt";
import { prepareShot } from "@/server/ai/images";

/*
 * One real analysis through the production code path (prompt + examples, schema, provider adapter, validation,
 * mapping, cost) on SYNTHETIC images: a rendered Hebrew title page with a "signature", and a plain cover.
 * Plus a measurement of the tokens the style examples add (two tiny text-only calls).
 */

async function textImage(lines: { text: string; px: number; font?: "classic" | "traditional" | "modern"; bold?: boolean }[], width: number, height: number, background: string) {
  const layers: sharp.OverlayOptions[] = [];
  let y = Math.round(height * 0.08);
  for (const l of lines) {
    const f = labelFont(l.font, l.bold);
    const t = await sharp({ text: { text: l.text, font: f.family, fontfile: f.file, width: Math.round(width * 0.8), dpi: Math.round(l.px * 6), rgba: true, align: "centre", rtl: true } as unknown as sharp.CreateText }).png().toBuffer({ resolveWithObject: true });
    layers.push({ input: t.data, top: y, left: Math.round((width - t.info.width) / 2) });
    y += t.info.height + Math.round(l.px * 0.9);
  }
  return sharp({ create: { width, height, channels: 3, background } }).composite(layers).jpeg({ quality: 88 }).toBuffer();
}

describe.skipIf(!process.env.BOOK_AI_LIVE)("live provider check (synthetic images)", () => {
  it("analyses a synthetic title page end to end and reports tokens and cost", async () => {
    const cfg = aiConfig();
    const active = activeProvider(cfg);
    const provider = createProvider(cfg);
    const lib = loadStyleLibrary();

    const title = await textImage(
      [
        { text: "ספר", px: 44, bold: true },
        { text: "חובות הלבבות", px: 96, bold: true },
        { text: "אשר חבר הרב החסיד רבינו בחיי בן יוסף ז\"ל", px: 34 },
        { text: "והעתיקו מלשון ערבי ללשון הקודש", px: 30 },
        { text: "הרב רבי יהודה אבן תבון ז\"ל", px: 30 },
        { text: "ועתה נדפס מחדש בהגהה רבה", px: 30 },
        { text: "בדפוס זאלקווא", px: 40, bold: true },
        { text: "בשנת תקנ\"ט לפ\"ק", px: 36 },
        { text: "שייך לה\"ה יעקב בן אברהם", px: 30, font: "modern" },
      ],
      1400,
      1900,
      "#efe4cc",
    );
    const cover = await sharp({ create: { width: 1200, height: 1700, channels: 3, background: "#5a3b22" } }).jpeg().toBuffer();
    // the same preparation as production: resized cover; title page at detail size plus its zoomed halves
    const c = await prepareShot(cover, { rotation: 0, detail: false, zoom: false }, cfg);
    const t = await prepareShot(title, { rotation: 0, detail: true, zoom: cfg.BOOK_AI_TITLE_ZOOM_PAGES > 0 }, cfg);
    const images = [
      { id: "img-01", label: "img-01 · כריכה · 1/1", data: c.full.data, mime: "image/jpeg" as const, detail: "auto" as const },
      { id: "img-02", label: "img-02 · שער · 1/1", data: t.full.data, mime: "image/jpeg" as const, detail: "high" as const },
      ...t.zooms.map((z) => ({ id: `img-02-${z.suffix}`, label: `img-02-${z.suffix} · הגדלה של img-02 (${z.name})`, data: z.data, mime: "image/jpeg" as const, detail: "high" as const })),
    ];
    const ctx: ItemContext = {
      itemType: null,
      title: "ספר ישן מוסר",
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
      photographerNotes: "יש חתימה בתחתית השער. הכריכה בלויה.",
      categoryNotes: [],
    };

    const started = Date.now();
    const res = await provider.generate({
      instructions: buildInstructions(lib),
      cacheKey: cacheKeyFor(lib),
      userText: buildAnalysisText(ctx, images, { skipped: [] }),
      images,
      schemaName: "item_analysis",
      schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: cfg.BOOK_AI_MAX_OUTPUT_TOKENS,
      timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
    });
    const ms = Date.now() - started;
    const result = parseAnswer(res.text, analysisResultZ);
    const empty = Object.fromEntries(AI_WRITABLE.map((f) => [f, f === "itemType" ? "UNKNOWN" : null])) as AiValues;
    const current = { ...empty, title: ctx.title };
    const mapped = mapResult({ result, current, base: current, previousAi: null, imageIds: new Set(images.map((i) => i.id)), catalogIsManual: false });
    const cost = computeCost(active.model, res.usage ? { ...res.usage } : null, { usageReported: !!res.usage });

    // examples overhead: the same tiny request with and without the examples block (input tokens as reported)
    const tiny = async (withExamples: boolean) =>
      (
        await provider.generate({
          instructions: withExamples ? buildInstructions(lib) : buildInstructions({ ...lib, block: "" }),
          cacheKey: `measure-${withExamples}`,
          userText: "בדיקת מדידה. החזר JSON תקין לפי הסכמה עבור פריט ללא נתונים.",
          images: [],
          schemaName: "item_analysis",
          schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
          maxOutputTokens: cfg.BOOK_AI_MAX_OUTPUT_TOKENS,
          timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
        })
      ).usage;
    const measure = process.env.BOOK_AI_LIVE_MEASURE !== "0";
    const [withEx, withoutEx] = measure ? [await tiny(true), await tiny(false)] : [null, null];

    const report = {
      at: new Date().toISOString(),
      provider: active.provider,
      model: res.model,
      promptVersion: PROMPT_VERSION,
      examples: { version: lib.version, hash: lib.hash, count: lib.examples.length, addedInputTokens: withEx && withoutEx ? withEx.inputTokens - withoutEx.inputTokens : null },
      analysis: { ms, usage: res.usage, costUsd: cost.costUsd, costEstimated: cost.estimated },
      measurementCalls: { withExamples: withEx, withoutExamples: withoutEx, costUsd: [withEx, withoutEx].reduce((s, u) => s + (computeCost(active.model, u ? { ...u } : null, { usageReported: true }).costUsd ?? 0), 0) },
      fields: Object.fromEntries(Object.entries(result.fields).map(([k, v]) => [k, `${v.status}${v.value ? `: ${v.value}` : ""} (${v.confidence ?? "-"}, ${v.source ?? "-"}, ${v.imageIds.join(" ")})`])),
      itemType: result.itemType,
      catalog: result.catalog,
      findings: result.findings,
      requiresReview: result.requiresReview,
      warnings: result.warnings,
      patch: mapped.patch,
      dashFree: Object.values(mapped.patch).every((v) => !hasForbiddenDash(String(v ?? ""))),
      rawHadForbiddenDash: hasForbiddenDash(JSON.stringify({ c: result.catalog, f: result.fields })),
    };
    fs.mkdirSync(path.resolve(".data/ai-live"), { recursive: true });
    fs.writeFileSync(path.resolve(`.data/ai-live/ai-live-${active.provider}${process.env.BOOK_AI_LIVE_TAG ? `-${process.env.BOOK_AI_LIVE_TAG}` : ""}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    expect(result.imagesReviewed.length).toBeGreaterThanOrEqual(2);
    expect(report.dashFree).toBe(true);
    expect(res.usage?.inputTokens).toBeGreaterThan(0);
  });
});
