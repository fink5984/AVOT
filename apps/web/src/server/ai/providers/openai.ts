import "server-only";
import { fetchWithTimeout, httpError, ProviderError, type AiProvider, type ProviderRequest, type ProviderResponse } from "./types";

/*
 * OpenAI Responses API (POST /v1/responses) over HTTPS with the official REST contract:
 *  - structured output: text.format = json_schema, strict;
 *  - images as base64 data URLs (input_image), each preceded by its id label;
 *  - store: false (the request is not kept for later retrieval on OpenAI's side);
 *  - prompt caching is automatic for identical prefixes of 1024+ tokens; prompt_cache_key keeps items that share
 *    the prompt + examples on the same cache. Cached tokens are reported in usage.input_tokens_details.cached_tokens.
 *  - no tools are offered, so the model can only answer.
 */

interface ResponsesBody {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly reasoningEffort?: string,
    /** what a "high" image (title page, zoom) is sent as: see BOOK_AI_OPENAI_DETAIL */
    private readonly highDetail: string = "high",
  ) {}

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const content: Record<string, unknown>[] = [{ type: "input_text", text: req.userText }];
    for (const img of req.images) {
      content.push({ type: "input_text", text: `[${img.label}]` });
      content.push({ type: "input_image", image_url: `data:${img.mime};base64,${img.data.toString("base64")}`, detail: img.detail === "high" ? this.highDetail : img.detail });
    }
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: req.instructions,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
      max_output_tokens: req.maxOutputTokens,
      store: false,
      prompt_cache_key: req.cacheKey,
    };
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort };

    const res = await fetchWithTimeout(
      `${this.baseUrl.replace(/\/$/, "")}/responses`,
      { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) },
      req.timeoutMs,
    );
    const requestId = res.headers.get("x-request-id");
    const raw = await res.text();
    if (!res.ok) throw httpError("OpenAI", res, raw, requestId);
    let j: ResponsesBody;
    try {
      j = JSON.parse(raw) as ResponsesBody;
    } catch {
      throw new ProviderError("server", "OpenAI: תשובה שאינה JSON", { requestId });
    }
    if (j.status === "incomplete") {
      const reason = j.incomplete_details?.reason ?? "unknown";
      throw new ProviderError(reason === "max_output_tokens" ? "truncated" : "refused", `OpenAI: התשובה נקטעה (${reason})`, { requestId });
    }
    if (j.status && j.status !== "completed") throw new ProviderError("server", `OpenAI: מצב תשובה ${j.status} ${j.error?.message ?? ""}`, { requestId });
    const parts = (j.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
    const refusal = parts.find((p) => p.type === "refusal");
    if (refusal) throw new ProviderError("refused", `OpenAI: המודל סירב (${(refusal.refusal ?? "").slice(0, 200)})`, { requestId });
    const text = parts
      .filter((p) => p.type === "output_text")
      .map((p) => p.text ?? "")
      .join("");
    if (!text.trim()) throw new ProviderError("server", "OpenAI: תשובה ריקה", { requestId });
    const u = j.usage;
    return {
      text,
      usage: u
        ? {
            inputTokens: u.input_tokens ?? 0,
            cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
            extraReasoningTokens: 0,
          }
        : null,
      model: j.model ?? this.model,
      requestId,
      finish: j.status ?? "completed",
    };
  }
}
