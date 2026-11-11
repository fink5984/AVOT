import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AiConfig } from "./config";
import { computeCost, type UsageTotals } from "./pricing";
import { ProviderError, type ProviderUsage } from "./providers/types";
import { webSearch } from "./research-providers";
import {
  RESEARCH_JSON_SCHEMA,
  RESEARCH_PROMPT_VERSION,
  RESEARCH_RULES,
  SEARCH_PRICE_USD,
  buildSearchQueries,
  effectiveSearchLimit,
  emptyResearch,
  hasSearchableIdentification,
  researchAnswerZ,
  vetSources,
  coerceResearchAnswer,
  type Identification,
  type ResearchRecord,
  type ResearchSettings,
} from "./research-core";
import type { AnalysisResult } from "./schema";
import { InvalidAnswerError, parseAnswer } from "./schema";
import { cleanWebText } from "./research-core";

/*
 * Stage C of the four-stage flow (identify -> queries -> research -> write): one web-search call with the provider's
 * own search tool. It never throws for a research problem: a failed or unavailable search is a RESEARCH RECORD with
 * status "failed" / "skipped" and a Hebrew reason, and the ordinary analysis goes on (and says the research was not done).
 */

/** What the research starts from: the analysis of the photos (never an earlier run's output). */
export function identificationFrom(result: AnalysisResult): Identification {
  const f = (k: keyof AnalysisResult["fields"]) => {
    const x = result.fields[k];
    return x.status === "found" && x.value?.trim() ? x.value.trim() : null;
  };
  const hl = result.catalogHighlight;
  return {
    title: f("title"),
    subtitle: f("subtitle"),
    author: f("author"),
    printPlace: f("printPlace"),
    printYear: f("printYear"),
    publisher: f("publisher"),
    edition: f("edition"),
    itemType: result.itemType.value === "UNKNOWN" ? null : result.itemType.value,
    mainFeature: hl?.status === "found" ? hl.mainFeature : null,
    marks: result.findings
      .filter((x) => ["signature", "dedication", "ownership_mark", "stamp", "handwritten_note"].includes(x.kind) && x.reading !== "illegible")
      .slice(0, 4)
      .map((x) => ({ kind: x.kind, text: x.transcription ? x.transcription.slice(0, 120) : null, attribution: x.attribution ? x.attribution.slice(0, 120) : null })),
    manuscriptSnippet: result.manuscriptAnalysis?.isManuscript ? (result.manuscriptAnalysis.transcription ?? null) : null,
  };
}

function researchUserText(id: Identification, queries: string[], s: ResearchSettings, maxSearches: number): string {
  const lines = [
    "# הפריט כפי שזוהה מהתמונות (ראיה ראשונית, לא מאומתת מול מקורות)",
    "```json",
    JSON.stringify(id, null, 2),
    "```",
    "",
    "# שאילתות חיפוש מוצעות (אפשר לדייק, להחליף איות או להוסיף שם חלופי של החיבור)",
    ...queries.map((q) => `- ${q}`),
    "",
    "# מגבלות",
    `- לכל היותר ${maxSearches} חיפושים, ולכל היותר ${s.maxSources} מקורות ב-sources (המועילים ביותר). אל תחזור על שאילתה שכבר חיפשת.`,
    `- זמן מוגבל: ${s.timeoutSeconds} שניות.`,
  ];
  return lines.join("\n");
}

export interface ResearchRun {
  record: ResearchRecord;
  /** token usage of the research call (added to the run's totals) */
  usage: ProviderUsage | null;
  /** the web-search part of the cost (not tokens) */
  searchCostUsd: number;
}

/** Which provider does the searching: the analysis provider ("auto") or the one chosen in settings, if it has a key. */
export function researchProviderFor(cfg: AiConfig, s: ResearchSettings): { provider: "openai" | "gemini"; model: string; apiKey: string; baseUrl: string; reasoning?: string } | { error: string } {
  const provider = s.provider === "auto" ? cfg.BOOK_AI_PROVIDER : s.provider;
  if (provider === "gemini") {
    if (!cfg.GEMINI_API_KEY) return { error: "חסר GEMINI_API_KEY בשרת" };
    return { provider, model: cfg.BOOK_AI_GEMINI_MODEL, apiKey: cfg.GEMINI_API_KEY, baseUrl: cfg.BOOK_AI_GEMINI_BASE_URL, reasoning: cfg.BOOK_AI_GEMINI_THINKING || undefined };
  }
  if (!cfg.OPENAI_API_KEY) return { error: "חסר OPENAI_API_KEY בשרת" };
  // web search does not run with reasoning "none" / "minimal"
  const configured = cfg.BOOK_AI_OPENAI_REASONING;
  return { provider: "openai", model: cfg.BOOK_AI_OPENAI_MODEL, apiKey: cfg.OPENAI_API_KEY, baseUrl: cfg.BOOK_AI_OPENAI_BASE_URL, reasoning: !configured || configured === "none" || configured === "minimal" ? "low" : configured };
}

/** Extracts a JSON object from a model answer that may have a code fence or text around it (Gemini without a schema). */
export function lenientJson(text: string): string {
  const fenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (fenced.startsWith("{")) return fenced;
  const a = fenced.indexOf("{");
  const b = fenced.lastIndexOf("}");
  return a >= 0 && b > a ? fenced.slice(a, b + 1) : fenced;
}

export async function runResearch(args: { cfg: AiConfig; settings: ResearchSettings; identification: Identification }): Promise<ResearchRun> {
  const { cfg, settings: s, identification: id } = args;
  const started = Date.now();
  const skipped = (reason: string, extra: Partial<ResearchRecord> = {}): ResearchRun => ({ record: emptyResearch("skipped", reason, s, extra), usage: null, searchCostUsd: 0 });
  if (!s.enabled) return skipped("המחקר החיצוני כבוי בהגדרות AI");
  if (!hasSearchableIdentification(id)) return skipped("לא זוהה שם חיבור או פרט אחר שאפשר לחפש לפיו");
  const p = researchProviderFor(cfg, s);
  if ("error" in p) return skipped(`שירות החיפוש אינו מוגדר (${p.error})`);
  const maxSearches = effectiveSearchLimit(s, p.provider);
  if (maxSearches < 1) return skipped("מגבלת העלות שהוגדרה למחקר נמוכה ממחיר חיפוש אחד");
  const queries = buildSearchQueries(id, Math.min(8, maxSearches + 3));
  const accessedAt = new Date().toISOString();
  try {
    const res = await webSearch({
      provider: p.provider,
      model: p.model,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      instructions: RESEARCH_RULES,
      userText: researchUserText(id, queries, s, maxSearches),
      schema: RESEARCH_JSON_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "item_research",
      maxSearches,
      maxOutputTokens: 6000,
      timeoutMs: s.timeoutSeconds * 1000,
      reasoning: p.reasoning,
    });
    let answer: z.infer<typeof researchAnswerZ>;
    try {
      answer = researchAnswerZ.parse(coerceResearchAnswer(JSON.parse(lenientJson(res.text))));
    } catch (err) {
      throw new ProviderError("server", "תשובת המחקר לא הייתה במבנה הנדרש");
    }
    const { sources, dropped } = vetSources(answer, res.citations, { maxSources: s.maxSources, hostOnly: res.hostOnly, accessedAt });
    const totals: UsageTotals | null = res.usage ? { inputTokens: res.usage.inputTokens, cachedInputTokens: res.usage.cachedInputTokens, outputTokens: res.usage.outputTokens, extraReasoningTokens: res.usage.extraReasoningTokens } : null;
    const tokenCost = computeCost(res.model, totals, { usageReported: !!res.usage });
    const searchCostUsd = Number((res.searches * SEARCH_PRICE_USD[p.provider]).toFixed(4));
    const costUsd = tokenCost.costUsd === null ? searchCostUsd : Number((tokenCost.costUsd + searchCostUsd).toFixed(6));
    const record = emptyResearch(sources.length ? "completed" : "partial", sources.length ? null : "החיפוש לא החזיר מקורות שאפשר היה לאמת שהכלי החזיר אותם", s, {
      provider: p.provider,
      model: res.model,
      queries,
      searched: res.searched.map((q) => cleanWebText(q, 200)),
      searches: res.searches,
      sources,
      summary: cleanWebText(answer.summary, 2000) || null,
      contradictions: answer.contradictions.map((x) => cleanWebText(x, 500)).filter(Boolean),
      requiresVerification: answer.requiresVerification.map((x) => cleanWebText(x, 400)).filter(Boolean),
      inaccessible: answer.inaccessible.map((x) => cleanWebText(x, 300)).filter(Boolean),
      droppedUnverified: dropped,
      costUsd,
      // the search price is a list-price estimate; token usage may be unreported
      costEstimated: true,
      durationMs: Date.now() - started,
      accessedAt,
    });
    return { record, usage: res.usage, searchCostUsd };
  } catch (err) {
    const reason = err instanceof ProviderError || err instanceof Error ? err.message : "שגיאה לא ידועה";
    const timedOut = err instanceof ProviderError && err.kind === "timeout";
    return {
      record: emptyResearch("failed", timedOut ? `המחקר לא הסתיים בתוך ${s.timeoutSeconds} שניות` : `המחקר החיצוני נכשל: ${reason}`.slice(0, 400), s, { provider: p.provider, model: p.model, queries, durationMs: Date.now() - started, accessedAt }),
      usage: null,
      searchCostUsd: 0,
    };
  }
}

/** Short fingerprint of the research rules, kept on the run's record (which instructions produced it). */
export const researchVersion = `${RESEARCH_PROMPT_VERSION}-${createHash("sha256").update(RESEARCH_RULES).digest("hex").slice(0, 8)}`;
