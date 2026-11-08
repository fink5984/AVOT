/*
 * The provider contract. Both providers receive exactly the same request (instructions = main prompt + style
 * examples, the item context, the images with their ids, the JSON Schema) and return the raw JSON text plus the
 * usage they reported. Nothing else: a provider can never act on the system - no tools, no function calling,
 * no browsing - it only answers.
 */

export interface ProviderImage {
  id: string;
  label: string;
  data: Buffer;
  mime: "image/jpeg";
  detail: "high" | "auto";
}

export interface ProviderRequest {
  /** static part first (prompt + examples): identical across items, so provider-side prompt caching applies */
  instructions: string;
  /** groups requests sharing the same static prefix (OpenAI prompt_cache_key) */
  cacheKey: string;
  /** the item-specific text (context JSON + image manifest) */
  userText: string;
  images: ProviderImage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ProviderUsage {
  /** all input tokens, cached ones included */
  inputTokens: number;
  cachedInputTokens: number;
  /** output tokens as billed at the output rate (OpenAI: includes reasoning) */
  outputTokens: number;
  /** thinking tokens (informational) */
  reasoningTokens: number;
  /** thinking tokens billed on top of outputTokens (Gemini) */
  extraReasoningTokens: number;
}

export interface ProviderResponse {
  text: string;
  /** null when the provider did not report usage */
  usage: ProviderUsage | null;
  /** the model id the provider says answered (may be a dated snapshot) */
  model: string;
  requestId: string | null;
  finish: string;
}

export type ProviderErrorKind = "rate_limit" | "quota" | "timeout" | "server" | "bad_request" | "auth" | "refused" | "truncated" | "network";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly opts: { status?: number; retryAfterMs?: number; requestId?: string | null } = {},
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === "rate_limit" || this.kind === "timeout" || this.kind === "server" || this.kind === "network";
  }
}

export interface AiProvider {
  readonly name: "openai" | "gemini";
  readonly model: string;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
}

/** fetch with a hard timeout; network failures and timeouts become ProviderErrors. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (ctl.signal.aborted) throw new ProviderError("timeout", `הספק לא השיב בתוך ${Math.round(timeoutMs / 1000)} שניות`);
    throw new ProviderError("network", `אין חיבור לספק ה-AI (${err instanceof Error ? err.message : "network"})`);
  } finally {
    clearTimeout(timer);
  }
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(s * 1000, 120_000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 120_000) : undefined;
}

/** Maps an HTTP failure to a ProviderError (message trimmed, never echoing request content). */
export function httpError(provider: string, res: Response, body: string, requestId: string | null): ProviderError {
  let message = body.slice(0, 400);
  try {
    const j = JSON.parse(body) as { error?: { message?: string; code?: string | number; status?: string; type?: string } };
    message = j.error?.message?.slice(0, 400) ?? message;
    if (res.status === 429 && /quota|billing|insufficient/i.test(`${j.error?.code} ${j.error?.type} ${j.error?.message}`) && !/rate/i.test(String(j.error?.type ?? ""))) {
      return new ProviderError("quota", `${provider}: מכסת השימוש או החיוב של החשבון נוצלה (${message})`, { status: 429, requestId });
    }
  } catch {
    /* body is not JSON */
  }
  const opts = { status: res.status, retryAfterMs: retryAfterMs(res), requestId };
  if (res.status === 429) return new ProviderError("rate_limit", `${provider}: חריגה ממגבלת הבקשות (${message})`, opts);
  if (res.status === 401 || res.status === 403) return new ProviderError("auth", `${provider}: מפתח ה-API נדחה (${res.status})`, opts);
  if (res.status === 408 || res.status === 504) return new ProviderError("timeout", `${provider}: תם הזמן (${res.status})`, opts);
  if (res.status >= 500) return new ProviderError("server", `${provider}: שגיאת שרת (${res.status}) ${message}`, opts);
  return new ProviderError("bad_request", `${provider}: הבקשה נדחתה (${res.status}) ${message}`, opts);
}
