import { expect, test } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/* Screenshots of the new sections (desktop + phone) for a visual check. Same prerequisites as ai-background.spec.ts. */
test.skip(!process.env.E2E_FAKE_AI, "needs the fake AI server and an app started against it: set E2E_FAKE_AI=1");

for (const [name, viewport] of [["desktop", { width: 1500, height: 1100 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`research section ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page);
    const created = await page.request.post("/api/inventory", { data: { title: `ספר צילום ${name} ${Date.now()}`, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } }).then((r) => r.json());
    const id = created.item.id as string;
    await page.goto(`/inventory/${id}`);
    await page.locator("[data-ai-status]").click();
    await expect(page.locator("[data-ai-status]")).toHaveAttribute("data-ai-status", "COMPLETED", { timeout: 120_000 });
    await page.reload();
    await page.getByTestId("research-toggle").click();
    await expect(page.getByTestId("research-sources")).toBeVisible();
    const out = process.env.SHOT_DIR ?? "test-results";
    await page.getByTestId("research-section").screenshot({ path: `${out}/research-${name}.png` });
    // no horizontal scroll on the whole page
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
