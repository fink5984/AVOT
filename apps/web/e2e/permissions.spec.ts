import { expect, test } from "@playwright/test";
import { ADMIN, login } from "./helpers";

/** Server-side permission enforcement — not just hidden buttons. */
test("roles are enforced by the API, invitations work, and photos are not reachable by URL guessing", async ({ page, browser }) => {
  await login(page);
  const email = `viewer${Date.now()}@avot.local`;
  const invite = await page.request.post("/api/users/invite", { data: { name: "צופה בדיקה", email, role: "VIEWER" }, headers: { origin: new URL(page.url()).origin } });
  expect(invite.status()).toBe(201);
  const { url } = await invite.json();

  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const viewer = await ctx.newPage();
  await viewer.goto(new URL(url).pathname);
  await viewer.getByLabel("סיסמה חדשה").fill("viewer-password-123");
  await viewer.getByLabel("אימות סיסמה").fill("viewer-password-123");
  await viewer.getByRole("button", { name: "הפעלת החשבון" }).click();
  await expect(viewer.getByRole("searchbox", { name: "חיפוש גלובלי" })).toBeVisible();
  const origin = { origin: new URL(viewer.url()).origin };

  // viewer can read …
  expect((await viewer.request.get("/api/catalogs")).status()).toBe(200);
  // … but cannot write, capture, manage users or stations
  expect((await viewer.request.post("/api/catalogs", { data: { number: "X1", name: "x" }, headers: origin })).status()).toBe(403);
  expect((await viewer.request.post("/api/users/invite", { data: { name: "x", email: "x@x.x", role: "ADMIN" }, headers: origin })).status()).toBe(403);
  expect((await viewer.request.post("/api/devices/pairing-code", { data: { name: "x" }, headers: origin })).status()).toBe(403);
  expect(
    (
      await viewer.request.post("/api/captures", {
        data: { captureId: crypto.randomUUID(), lotId: crypto.randomUUID(), category: "COVER", source: "WEBCAM", capturedAt: new Date().toISOString(), files: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, sha256: "a".repeat(64) }] },
        headers: origin,
      })
    ).status(),
  ).toBe(403);
  // admin-only pages redirect
  await viewer.goto("/settings/users");
  await expect(viewer).toHaveURL(/denied=1/);

  // unauthenticated: no API access, no image access, no export access
  const anon = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const a = await anon.newPage();
  expect((await a.request.get("/api/catalogs")).status()).toBe(401);
  expect((await a.request.get(`/api/assets/${crypto.randomUUID()}/original`)).status()).toBe(401);
  expect((await a.request.get(`/api/files?t=forged.token`)).status()).toBe(403);
  await a.goto("/catalogs");
  await expect(a).toHaveURL(/\/login/);

  // login rate limiting
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await a.request.post("/api/auth/login", { data: { email: ADMIN.email + ".nope", password: "x" }, headers: { origin: new URL(viewer.url()).origin } });
    limited = r.status() === 429;
  }
  expect(limited).toBeTruthy();
  await ctx.close();
  await anon.close();
});
