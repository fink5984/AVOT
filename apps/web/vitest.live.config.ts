import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * LIVE check against the active AI provider (costs real money - a few cents per run). Never part of `npm test`.
 * Reads OPENAI_API_KEY / GEMINI_API_KEY / BOOK_AI_PROVIDER from .env.local; uses no database and only synthetic images.
 *   npx vitest run -c vitest.live.config.ts
 *   $env:BOOK_AI_PROVIDER="gemini"; npx vitest run -c vitest.live.config.ts
 * Results (tokens, cost, the answer) are written to .data/ai-live/ai-live-<provider>.json (git-ignored; Playwright clears test-results).
 */
const local = loadEnv({ path: path.resolve(__dirname, ".env.local"), processEnv: {} }).parsed ?? {};
const pick = (k: string) => process.env[k] ?? local[k] ?? "";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["test/live/**/*.live.ts"],
    environment: "node",
    testTimeout: 600_000,
    env: {
      APP_SECRET: "unit-test-secret-unit-test-secret-0000",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      APP_URL: "http://localhost:3000",
      APP_ENV: "test",
      BOOK_AI_LIVE: "1",
      ...(process.env.BOOK_AI_LIVE_MEASURE ? { BOOK_AI_LIVE_MEASURE: process.env.BOOK_AI_LIVE_MEASURE } : {}),
      ...(process.env.BOOK_AI_LIVE_TAG ? { BOOK_AI_LIVE_TAG: process.env.BOOK_AI_LIVE_TAG } : {}),
      ...Object.fromEntries(
        ["BOOK_AI_PROVIDER", "OPENAI_API_KEY", "BOOK_AI_OPENAI_MODEL", "BOOK_AI_OPENAI_REASONING", "GEMINI_API_KEY", "BOOK_AI_GEMINI_MODEL", "BOOK_AI_GEMINI_THINKING"]
          .map((k) => [k, pick(k)])
          .filter(([, v]) => v),
      ),
    },
  },
});
