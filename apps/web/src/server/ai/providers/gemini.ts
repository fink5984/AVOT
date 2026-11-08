import "server-only";
import { fetchWithTimeout, httpError, ProviderError, type AiProvider, type ProviderRequest, type ProviderResponse } from "./types";

/*
 * Gemini API generateContent (POST /v1beta/models/{model}:generateContent) over HTTPS, key in the x-goog-api-key header:
 *  - structured output: responseMimeType application/json + responseJsonSchema (the same JSON Schema as OpenAI).
 *    If the endpoint rejects responseJsonSchema, the request is retried once with the older OpenAPI-style
 *    responseSchema converted from the same schema (see toOpenApiSchema);
 *  - images inline (inlineData, base64), each preceded by its id label;
 *  - caching: Gemini applies implicit caching automatically to repeated prefixes (systemInstruction first);
 *    hits are reported as usageMetadata.cachedContentTokenCount. Explicit cachedContents are not used (they add a
 *    storage charge per hour and are only worth it at high volume);
 *  - thinking tokens (thoughtsTokenCount) are billed in addition to candidatesTokenCount;
 *  - no tools are offered, so the model can only answer.
 */

interface GenerateBody {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  responseId?: string;
}

/** JSON Schema → Gemini OpenAPI schema subset: ["x","null"] → nullable, no additionalProperties, ordered properties. */
export function toOpenApiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toOpenApiSchema);
  if (!s || typeof s !== "object") return s;
  const src = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0];
      if (v.includes("null")) out.nullable = true;
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.filter((x) => x !== null);
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toOpenApiSchema(pv)]));
      out.propertyOrdering = Object.keys(v);
    } else out[k] = toOpenApiSchema(v);
  }
  return out;
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly thinkingLevel?: string,
  ) {}

  private body(req: ProviderRequest, legacySchema: boolean) {
    const parts: Record<string, unknown>[] = [{ text: req.userText }];
    for (const img of req.images) {
      parts.push({ text: `[${img.label}]` });
      parts.push({ inlineData: { mimeType: img.mime, data: img.data.toString("base64") } });
    }
    const generationConfig: Record<string, unknown> = {
      responseMimeType: "application/json",
      maxOutputTokens: req.maxOutputTokens,
      ...(legacySchema ? { responseSchema: toOpenApiSchema(req.schema) } : { responseJsonSchema: req.schema }),
    };
    if (this.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.thinkingLevel };
    return { systemInstruction: { parts: [{ text: req.instructions }] }, contents: [{ role: "user", parts }], generationConfig };
  }

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(this.model)}:generateContent`;
    const send = (legacy: boolean) =>
      fetchWithTimeout(url, { method: "POST", headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" }, body: JSON.stringify(this.body(req, legacy)) }, req.timeoutMs);
    let res = await send(false);
    let raw = await res.text();
    if (res.status === 400 && /responseJsonSchema|response_json_schema/i.test(raw)) {
      res = await send(true);
      raw = await res.text();
    }
    if (!res.ok) throw httpError("Gemini", res, raw, null);
    let j: GenerateBody;
    try {
      j = JSON.parse(raw) as GenerateBody;
    } catch {
      throw new ProviderError("server", "Gemini: תשובה שאינה JSON");
    }
    const requestId = j.responseId ?? null;
    if (j.promptFeedback?.blockReason) throw new ProviderError("refused", `Gemini: הבקשה נחסמה (${j.promptFeedback.blockReason})`, { requestId });
    const cand = j.candidates?.[0];
    const finish = cand?.finishReason ?? "UNKNOWN";
    if (finish === "MAX_TOKENS") throw new ProviderError("truncated", "Gemini: התשובה נקטעה (MAX_TOKENS)", { requestId });
    if (finish !== "STOP" && finish !== "UNKNOWN") throw new ProviderError("refused", `Gemini: התשובה הופסקה (${finish})`, { requestId });
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!text.trim()) throw new ProviderError("server", "Gemini: תשובה ריקה", { requestId });
    const u = j.usageMetadata;
    return {
      text,
      usage: u
        ? {
            inputTokens: u.promptTokenCount ?? 0,
            cachedInputTokens: u.cachedContentTokenCount ?? 0,
            outputTokens: u.candidatesTokenCount ?? 0,
            reasoningTokens: u.thoughtsTokenCount ?? 0,
            extraReasoningTokens: u.thoughtsTokenCount ?? 0,
          }
        : null,
      model: j.modelVersion ?? this.model,
      requestId,
      finish,
    };
  }
}
