import "server-only";
import { z } from "zod";
import { AppError } from "../errors";

/*
 * AI analysis configuration — environment only, no settings screen. Switching provider is one variable:
 *   BOOK_AI_PROVIDER=openai | gemini
 * Keys stay on the server (never NEXT_PUBLIC_*). Model ids are configuration, never hard-coded in the logic;
 * the defaults below are only the suggested starting points (checked against the providers on 2026-11-07).
 */

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  BOOK_AI_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  BOOK_AI_OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  /**
   * reasoning effort (none | minimal | low | medium | high); empty = the model's own default.
   * "low" measured best for gpt-5.4-mini on Hebrew title pages (2026-11-07): far better readings than none at the
   * same cost; medium cost 2.6x without better results.
   */
  BOOK_AI_OPENAI_REASONING: z.string().trim().default("low"),
  BOOK_AI_OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  GEMINI_API_KEY: z.string().optional(),
  BOOK_AI_GEMINI_MODEL: z.string().trim().min(1).default("gemini-3-flash-preview"),
  /** Gemini 3 thinking level (minimal | low | medium | high); empty = the model's default */
  BOOK_AI_GEMINI_THINKING: z.string().trim().optional(),
  BOOK_AI_GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  /** images in one provider request; more images are analysed in stages (see services/ai-analysis.ts) */
  BOOK_AI_MAX_IMAGES_PER_REQUEST: int(16, 1, 100),
  /** total image bytes (after preparation) in one request */
  BOOK_AI_MAX_REQUEST_MB: int(14, 1, 45),
  /** long edge of an ordinary image sent to the model */
  BOOK_AI_IMAGE_MAX_EDGE: int(1600, 512, 4096),
  /** long edge of title pages and their zoomed halves (small text, signatures) */
  BOOK_AI_DETAIL_MAX_EDGE: int(2400, 768, 4096),
  /** zoomed top / bottom halves of the first title pages: 0 disables */
  BOOK_AI_TITLE_ZOOM_PAGES: int(2, 0, 6),
  BOOK_AI_JPEG_QUALITY: int(82, 50, 95),
  BOOK_AI_MAX_OUTPUT_TOKENS: int(16000, 1000, 64000),
  BOOK_AI_TIMEOUT_SECONDS: int(240, 20, 900),
  /** whole-request token budget (instructions + examples + item + images, estimated before sending) */
  BOOK_AI_MAX_INPUT_TOKENS: int(200000, 8000, 2000000),
  /**
   * Price overrides, USD per 1M tokens, JSON: {"gpt-5.4-mini":{"input":0.75,"cachedInput":0.075,"output":4.5}}.
   * Merged over the built-in table in pricing.ts.
   */
  BOOK_AI_PRICING: z.string().optional(),
});

export type AiConfig = z.infer<typeof schema>;
export type ProviderName = AiConfig["BOOK_AI_PROVIDER"];

/** Read on every call (cheap): a changed variable takes effect after the process restarts, without code changes. */
export function aiConfig(source: Record<string, string | undefined> = process.env): AiConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new AppError("INTERNAL", `הגדרות ה-AI אינן תקינות (${lines})`);
  }
  return parsed.data;
}

export interface ActiveProvider {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

/** The one active provider. Throws a clear Hebrew error when its key is missing. */
export function activeProvider(cfg: AiConfig = aiConfig()): ActiveProvider {
  if (cfg.BOOK_AI_PROVIDER === "gemini") {
    if (!cfg.GEMINI_API_KEY) throw new AppError("CONFLICT", "ניתוח AI אינו מוגדר: חסר GEMINI_API_KEY בשרת");
    return { provider: "gemini", model: cfg.BOOK_AI_GEMINI_MODEL, apiKey: cfg.GEMINI_API_KEY };
  }
  if (!cfg.OPENAI_API_KEY) throw new AppError("CONFLICT", "ניתוח AI אינו מוגדר: חסר OPENAI_API_KEY בשרת");
  return { provider: "openai", model: cfg.BOOK_AI_OPENAI_MODEL, apiKey: cfg.OPENAI_API_KEY };
}

/** For the UI: is analysis possible at all (without revealing anything about the key). */
export function aiAvailable(): boolean {
  try {
    activeProvider();
    return true;
  } catch {
    return false;
  }
}
