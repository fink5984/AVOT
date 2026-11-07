import "server-only";
import { activeProvider, aiConfig, type AiConfig } from "../config";
import { GeminiProvider } from "./gemini";
import { OpenAiProvider } from "./openai";
import type { AiProvider } from "./types";

export type { AiProvider } from "./types";

/** The single active provider from BOOK_AI_PROVIDER. Changing provider = changing that variable, nothing else. */
export function createProvider(cfg: AiConfig = aiConfig()): AiProvider {
  const p = activeProvider(cfg);
  return p.provider === "gemini"
    ? new GeminiProvider(p.model, p.apiKey, cfg.BOOK_AI_GEMINI_BASE_URL, cfg.BOOK_AI_GEMINI_THINKING || undefined)
    : new OpenAiProvider(p.model, p.apiKey, cfg.BOOK_AI_OPENAI_BASE_URL, cfg.BOOK_AI_OPENAI_REASONING || undefined);
}

/** Test seam: integration tests install a fake provider so no network call is ever made. */
let override: AiProvider | null = null;
export function setProviderOverride(p: AiProvider | null) {
  override = p;
}
export function providerForRun(cfg?: AiConfig): AiProvider {
  return override ?? createProvider(cfg);
}
