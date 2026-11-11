import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aiConfig } from "@/server/ai/config";
import { runResearch } from "@/server/ai/research";
import { RESEARCH_DEFAULTS, type Identification } from "@/server/ai/research-core";

/*
 * ONE real web-search call through the production research code (costs a few cents, never part of `npm test`):
 *   npx vitest run -c vitest.live.config.ts test/live/research-live.live.ts
 *   $env:BOOK_AI_PROVIDER="gemini"; npx vitest run -c vitest.live.config.ts test/live/research-live.live.ts
 * Uses a public, well-known book (no data of the system). The record is written to .data/ai-live/research-<provider>.json.
 */
const ident: Identification = {
  title: "ספר חובות הלבבות",
  subtitle: null,
  author: "רבינו בחיי אבן פקודה",
  printPlace: "זולקווא",
  printYear: "תקנ\"ט [1799]",
  publisher: null,
  edition: null,
  itemType: "BOOK",
  mainFeature: null,
  marks: [],
  manuscriptSnippet: null,
};

describe.skipIf(!process.env.BOOK_AI_LIVE)("live web research", () => {
  it("searches, returns only links the search tool reported, and records the cost", async () => {
    const cfg = aiConfig();
    const settings = { ...RESEARCH_DEFAULTS, maxSearches: 2, maxSources: 4, timeoutSeconds: 240 };
    const run = await runResearch({ cfg, settings, identification: ident });
    const dir = path.resolve(__dirname, "../../.data/ai-live");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `research-${cfg.BOOK_AI_PROVIDER}.json`), JSON.stringify(run, null, 2));
    console.log(JSON.stringify({ status: run.record.status, reason: run.record.reason, provider: run.record.provider, model: run.record.model, searches: run.record.searches, sources: run.record.sources.map((s) => [s.url, s.kind, s.refersTo, s.urlCheck]), dropped: run.record.droppedUnverified, costUsd: run.record.costUsd, ms: run.record.durationMs, queries: run.record.searched }, null, 1));
    expect(["completed", "partial"]).toContain(run.record.status);
    for (const s of run.record.sources) expect(s.url).toMatch(/^https?:\/\//);
  });
});
