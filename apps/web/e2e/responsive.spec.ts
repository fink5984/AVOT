import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Catalog and gallery management must work on a phone without sideways scrolling. */
test("phone width: no horizontal overflow, navigation drawer works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  for (const path of ["/", "/catalogs", "/search", "/settings"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  await page.getByRole("button", { name: "פתיחת תפריט" }).click();
  // Phase 2 navigation: catalogs live under "בתי מכירות" → אבות / טבין
  await page.getByRole("navigation", { name: "ניווט ראשי" }).getByRole("link", { name: "אבות", exact: true }).click();
  await expect(page).toHaveURL(/\/houses\/avot$/);
});
