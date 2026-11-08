import "server-only";
import { aiConfig } from "./config";

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  /** cached input (prompt cache hit); defaults to input when unknown */
  cachedInput?: number;
  output: number;
  /** thinking tokens billed separately (Gemini); defaults to output */
  reasoning?: number;
}

/**
 * Standard-tier list prices, read from the providers' pricing pages on 2026-11-07. Prices change: override with
 * BOOK_AI_PRICING instead of editing code. A model missing here gets cost = null and costEstimated = true.
 */
const BUILT_IN: Record<string, ModelPrice> = {
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gemini-3-flash-preview": { input: 0.5, cachedInput: 0.05, output: 3 },
  "gemini-3.6-flash": { input: 0.75, cachedInput: 0.075, output: 3.75 },
  "gemini-3.8-flash": { input: 0.75, cachedInput: 0.075, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, cachedInput: 0.03, output: 2.5 },
};

export function priceFor(model: string, overridesJson = aiConfig().BOOK_AI_PRICING): ModelPrice | null {
  let overrides: Record<string, ModelPrice> = {};
  if (overridesJson) {
    try {
      overrides = JSON.parse(overridesJson) as Record<string, ModelPrice>;
    } catch {
      overrides = {};
    }
  }
  const table = { ...BUILT_IN, ...overrides };
  // dated snapshots ("gpt-5.4-mini-2026-03-17") are priced like their alias
  return table[model] ?? table[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? null;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** thinking tokens that are billed IN ADDITION to outputTokens (Gemini). OpenAI's reasoning tokens are inside outputTokens. */
  extraReasoningTokens: number;
}

/**
 * Cost from provider-reported usage × configured price. Neither provider returns a billed amount, so this is always a
 * calculation; `estimated` is true when the price or the usage was not available (then the figure is a rough guide).
 */
export function computeCost(model: string, usage: UsageTotals | null, opts: { usageReported: boolean }): { costUsd: number | null; estimated: boolean; price: ModelPrice | null } {
  const price = priceFor(model);
  if (!price || !usage) return { costUsd: null, estimated: true, price };
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const usd =
    ((usage.inputTokens - cached) * price.input +
      cached * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output +
      usage.extraReasoningTokens * (price.reasoning ?? price.output)) /
    1_000_000;
  return { costUsd: Number(usd.toFixed(6)), estimated: !opts.usageReported, price };
}
