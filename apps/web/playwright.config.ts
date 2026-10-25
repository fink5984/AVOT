import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * E2E tests run against the real app + database. Chromium's fake media
 * device makes getUserMedia return a real (synthetic) camera stream, so the
 * Webcam Mode pipeline is exercised end to end without hardware.
 * Canon EDSDK hardware is NOT covered here — see docs/hardware-acceptance.md.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["camera"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `${BASE}/api/health`,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
