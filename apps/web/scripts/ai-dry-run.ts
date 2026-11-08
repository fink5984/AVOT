/**
 * AI analysis dry run: the same images, prompt and examples as a real run, sent to the active provider, and the
 * answer printed / saved as JSON. It never writes to the database or to storage (only SELECTs and reads), so it can
 * be pointed at real data to compare settings or providers on the same item before changing anything.
 *
 *   npm run ai:dry-run -w apps/web -- <inventoryNumber> [out.json]
 *
 * Every variable of the real analysis applies (BOOK_AI_PROVIDER, BOOK_AI_OPENAI_DETAIL, ...). It costs money:
 * one provider call (more when the item has many images).
 * Run with `--conditions=react-server` (the npm script does) so server-only modules load outside Next.
 */
import { writeFileSync } from "node:fs";
import { db } from "../src/server/db";
import { aiConfig } from "../src/server/ai/config";
import { batchImages, prepareImages } from "../src/server/ai/images";
import { buildAnalysisText, buildInstructions, cacheKeyFor, HEBREW_AGAIN } from "../src/server/ai/prompt-builder";
import { createProvider } from "../src/server/ai/providers";
import { analysisResultZ, ANALYSIS_JSON_SCHEMA, englishExplanations, parseAnswer } from "../src/server/ai/schema";
import { loadStyleLibrary } from "../src/server/ai/style-examples";
import { computeCost } from "../src/server/ai/pricing";
import { aiFilledFields, itemContext } from "../src/server/services/ai-analysis";

async function main() {
  const [num, out] = process.argv.slice(2);
  if (!num) throw new Error("usage: ai-dry-run <inventoryNumber> [out.json]");
  const item = await db.inventoryItem.findFirst({ where: { inventoryNumber: num }, include: { categoryNotes: true } });
  if (!item) throw new Error(`item ${num} not found`);
  const cfg = aiConfig();
  const provider = createProvider(cfg);
  const lib = loadStyleLibrary();
  const prepared = await prepareImages(item.organizationId, item.id, cfg);
  const batches = batchImages(prepared.images, cfg.BOOK_AI_MAX_IMAGES_PER_REQUEST, cfg.BOOK_AI_MAX_REQUEST_MB * 1024 * 1024);
  if (batches.length > 1) console.warn(`note: ${batches.length} batches; the dry run sends only the first (the real run adds observation stages)`);
  const images = batches[0] ?? [];
  const started = Date.now();
  const req = {
    instructions: buildInstructions(lib),
    userText: buildAnalysisText(itemContext(item, item.categoryNotes, await aiFilledFields(item)), images, { skipped: [] }),
    images: images.map((i) => ({ id: i.id, label: i.label, data: i.data, mime: i.mime, detail: i.detail })),
    schemaName: "item_analysis",
    schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
    cacheKey: cacheKeyFor(lib),
    maxOutputTokens: cfg.BOOK_AI_MAX_OUTPUT_TOKENS,
    timeoutMs: cfg.BOOK_AI_TIMEOUT_SECONDS * 1000,
  };
  let res = await provider.generate(req);
  let result = parseAnswer(res.text, analysisResultZ);
  // same as a real run: an answer that explains in English is asked for once more
  const english = englishExplanations(result);
  if (english.length) {
    console.warn(`note: ${english.length} explanations in English, asking again in Hebrew`);
    const first = res.usage;
    res = await provider.generate({ ...req, userText: req.userText + HEBREW_AGAIN });
    result = parseAnswer(res.text, analysisResultZ);
    if (first && res.usage) res.usage = { ...res.usage, inputTokens: res.usage.inputTokens + first.inputTokens, cachedInputTokens: res.usage.cachedInputTokens + first.cachedInputTokens, outputTokens: res.usage.outputTokens + first.outputTokens };
  }
  const cost = computeCost(res.model || provider.model, res.usage, { usageReported: !!res.usage });
  const summary = {
    item: num,
    provider: provider.name,
    model: res.model || provider.model,
    detail: provider.name === "openai" ? cfg.BOOK_AI_OPENAI_DETAIL : undefined,
    detailEdge: cfg.BOOK_AI_DETAIL_MAX_EDGE,
    images: images.map((i) => `${i.id} ${i.width}x${i.height}`),
    usage: res.usage,
    cost,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    fields: Object.fromEntries(Object.entries(result.fields).map(([k, f]) => [k, f.status === "found" ? `${f.value} (${f.confidence})` : `[${f.status}]`])),
    headline: result.catalog.headline,
    description: result.catalog.description,
    findings: result.findings.map((f) => `${f.kind}: ${f.transcription ?? "-"} (${f.reading})`),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out) writeFileSync(out, JSON.stringify({ summary, result }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
