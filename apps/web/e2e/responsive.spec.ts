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

/** The users list and the picking list turn into cards on a phone, and no screen scrolls sideways at the narrowest widths. */
test("phone widths: users, picking and warehouse have no sideways scroll", async ({ page }) => {
  await login(page);
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/settings/users", "/warehouse", "/warehouse/picking", "/scanner?mobile=1"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/settings/users");
  await expect(page.getByRole("list", { name: "משתמשים" })).toBeVisible();
  await expect(page.locator("table")).toBeHidden();
});
