import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Integration tests that need a real PostgreSQL (schema migrated). Never point IT_DATABASE_URL at a
 * production / shared database: the tests create their own organization and leave it behind.
 *   $env:IT_DATABASE_URL="postgresql://…/avot_it"; npx vitest run -c vitest.integration.config.ts
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["test/integration/**/*.it.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      APP_SECRET: "unit-test-secret-unit-test-secret-0000",
      DATABASE_URL: process.env.IT_DATABASE_URL ?? "",
      APP_URL: "http://localhost:3000",
      APP_ENV: "test",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: path.resolve(__dirname, ".data/it-storage"),
      LOG_LEVEL: "error",
    },
  },
});
