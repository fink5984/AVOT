import "server-only";
import { fetchWithTimeout, httpError, ProviderError, type ProviderUsage } from "./providers/types";
import type { Citation } from "./research-core";

/*
 * The provider's OWN web search, used for the research step only (the analysis and writing calls still offer no
 * tools). No separate search service and no extra key: OpenAI's `web_search` tool and Gemini's `google_search`
 * grounding are part of the API the organization already pays for - billed per search on top of tokens (see
 * SEARCH_PRICE_USD in research-core.ts; prices change, check the provider's pricing page).
 *
 * The call returns the model's JSON answer plus what the SEARCH TOOL reported (citations, grounding chunks, the
 * queries it ran). The caller trusts the latter, not the model's typed links.
 */

export interface WebSearchRequest {
  provider: "openai" | "gemini";
  model: string;
  apiKey: string;
  baseUrl: string;
  instructions: string;
  userText: string;
  /** JSON Schema of the answer (OpenAI strict structured output); Gemini is asked for JSON in the prompt */
  schema: Record<string, unknown>;
  schemaName: string;
  maxSearches: number;
  maxOutputTokens: number;
  timeoutMs: number;
  reasoning?: string;
}

export interface WebSearchResponse {
  text: string;
  citations: Citation[];
  /** what the search tool searched for */
  searched: string[];
  searches: number;
  /** the provider reports the site of a result, not its page (Gemini grounding): links can only be checked by host */
  hostOnly: boolean;
  usage: ProviderUsage | null;
  model: string;
  requestId: string | null;
}

interface OpenAiBody {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: {
    type: string;
    action?: { type?: string; query?: string; queries?: string[]; sources?: { url?: string; title?: string }[] };
    content?: { type: string; text?: string; refusal?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  }[];
  usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

async function openAiSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
  const url = `${req.baseUrl.replace(/\/$/, "")}/responses`;
  const make = (strip: { format?: boolean; include?: boolean }) => {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: req.userText }] }],
      tools: [{ type: "web_search" }],
      max_tool_calls: req.maxSearches,
      max_output_tokens: req.maxOutputTokens,
      store: false,
    };
    if (!strip.include) body.include = ["web_search_call.action.sources"];
    if (!strip.format) body.text = { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } };
    if (req.reasoning) body.reasoning = { effort: req.reasoning };
    return JSON.stringify(body);
  };
  const send = (strip: { format?: boolean; include?: boolean }) => fetchWithTimeout(url, { method: "POST", headers: { authorization: `Bearer ${req.apiKey}`, "content-type": "application/json" }, body: make(strip) }, req.timeoutMs);
  let res = await send({});
  let raw = await res.text();
  // an older / different endpoint may reject an optional parameter: retry once without the optional parts
  if (res.status === 400 && /include|max_tool_calls|json_schema|text\.format|strict/i.test(raw)) {
    res = await send({ include: true, format: /json_schema|text\.format|strict/i.test(raw) });
    raw = await res.text();
  }
  const requestId = res.headers.get("x-request-id");
  if (!res.ok) throw httpError("OpenAI", res, raw, requestId);
  let j: OpenAiBody;
  try {
    j = JSON.parse(raw) as OpenAiBody;
  } catch {
    throw new ProviderError("server", "OpenAI: תשובה שאינה JSON", { requestId });
  }
  if (j.status === "incomplete") throw new ProviderError(j.incomplete_details?.reason === "max_output_tokens" ? "truncated" : "refused", `OpenAI: תשובת המחקר נקטעה (${j.incomplete_details?.reason ?? "unknown"})`, { requestId });
  if (j.status && j.status !== "completed") throw new ProviderError("server", `OpenAI: מצב תשובה ${j.status} ${j.error?.message ?? ""}`, { requestId });
  const out = j.output ?? [];
  const parts = out.filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  if (parts.some((p) => p.type === "refusal")) throw new ProviderError("refused", "OpenAI: המודל סירב לבקשת המחקר", { requestId });
  const text = parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new ProviderError("server", "OpenAI: תשובת מחקר ריקה", { requestId });
  const calls = out.filter((o) => o.type === "web_search_call");
  const searched = calls.flatMap((c) => [c.action?.query, ...(c.action?.queries ?? [])]).filter((q): q is string => !!q);
  const citations: Citation[] = [
    ...parts.flatMap((p) => p.annotations ?? []).filter((a) => a.type === "url_citation" && a.url).map((a) => ({ url: a.url!, title: a.title ?? null })),
    ...calls.flatMap((c) => c.action?.sources ?? []).filter((s) => s.url).map((s) => ({ url: s.url!, title: s.title ?? null })),
  ];
  const u = j.usage;
  return {
    text,
    citations,
    searched: [...new Set(searched)],
    searches: calls.length,
    hostOnly: false,
    usage: u ? { inputTokens: u.input_tokens ?? 0, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0, outputTokens: u.output_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0, extraReasoningTokens: 0 } : null,
    model: j.model ?? req.model,
    requestId,
  };
}

interface GeminiBody {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  responseId?: string;
}

async function geminiSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
  const url = `${req.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(req.model)}:generateContent`;
  // grounding with a response schema is not offered by every model: the answer is asked for as JSON in the prompt
  const body = {
    systemInstruction: { parts: [{ text: req.instructions }] },
    contents: [{ role: "user", parts: [{ text: `${req.userText}\n\nהחזר רק אובייקט JSON אחד (בלי טקסט נוסף ובלי גדרות קוד) במבנה הבא:\n${JSON.stringify(req.schema.properties ? Object.fromEntries(Object.keys(req.schema.properties as object).map((k) => [k, "..."])) : {})}\nכל מקור ב-sources: url, title, siteName, kind, refersTo, learned, relevance, contradicts, needsVerification.` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: req.maxOutputTokens, ...(req.reasoning ? { thinkingConfig: { thinkingLevel: req.reasoning } } : {}) },
  };
  const res = await fetchWithTimeout(url, { method: "POST", headers: { "x-goog-api-key": req.apiKey, "content-type": "application/json" }, body: JSON.stringify(body) }, req.timeoutMs);
  const raw = await res.text();
  if (!res.ok) throw httpError("Gemini", res, raw, null);
  let j: GeminiBody;
  try {
    j = JSON.parse(raw) as GeminiBody;
  } catch {
    throw new ProviderError("server", "Gemini: תשובה שאינה JSON");
  }
  const requestId = j.responseId ?? null;
  if (j.promptFeedback?.blockReason) throw new ProviderError("refused", `Gemini: הבקשה נחסמה (${j.promptFeedback.blockReason})`, { requestId });
  const cand = j.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") throw new ProviderError("truncated", "Gemini: תשובת המחקר נקטעה", { requestId });
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text.trim()) throw new ProviderError("server", "Gemini: תשובת מחקר ריקה", { requestId });
  const queries = cand?.groundingMetadata?.webSearchQueries ?? [];
  // grounding chunks carry a redirect address and the site's name as the title: only the site can be checked
  const citations: Citation[] = (cand?.groundingMetadata?.groundingChunks ?? []).filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri!, title: c.web!.title ?? null }));
  const u = j.usageMetadata;
  return {
    text,
    citations,
    searched: [...new Set(queries)],
    searches: queries.length,
    hostOnly: true,
    usage: u ? { inputTokens: u.promptTokenCount ?? 0, cachedInputTokens: u.cachedContentTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, reasoningTokens: u.thoughtsTokenCount ?? 0, extraReasoningTokens: u.thoughtsTokenCount ?? 0 } : null,
    model: j.modelVersion ?? req.model,
    requestId,
  };
}

/** Test seam: integration tests install a fake search so no network call is ever made. */
let override: ((req: WebSearchRequest) => Promise<WebSearchResponse>) | null = null;
export function setWebSearchOverride(f: ((req: WebSearchRequest) => Promise<WebSearchResponse>) | null) {
  override = f;
}

export function webSearch(req: WebSearchRequest): Promise<WebSearchResponse> {
  if (override) return override(req);
  return req.provider === "gemini" ? geminiSearch(req) : openAiSearch(req);
}
