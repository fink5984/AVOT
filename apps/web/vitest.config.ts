import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // server modules import "server-only"; it is a no-op outside React Server Components
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: {
      APP_SECRET: "unit-test-secret-unit-test-secret-0000",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      APP_URL: "http://localhost:3000",
      APP_ENV: "test",
    },
  },
});
