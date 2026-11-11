import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** The inventory list on a phone: cards instead of a table, compact search with a filter toggle, no sideways scroll. */
for (const width of [320, 390, 430]) {
  test(`inventory on a phone, ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await page.goto("/inventory");
    const cards = page.getByRole("list", { name: "ספרים במלאי" });
    await expect(cards).toBeVisible();
    await expect(page.locator("table")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // the selects hide behind one button
    await expect(page.getByLabel("מיון")).toBeHidden();
    await page.getByRole("button", { name: /סינון ומיון/ }).click();
    await expect(page.getByLabel("מיון")).toBeVisible();
    await expect(page.getByLabel("מצב פרטי הפריט")).toBeVisible();
    // selecting a card shows the action bar inside the screen
    await cards.getByRole("checkbox").first().check();
    const bar = page.getByText(/נבחרו \d+ ספרים/);
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/inventory-${width}.png` });
  });
}
test("inventory on desktop still shows the table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await page.goto("/inventory");
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByLabel("מיון")).toBeVisible();
});
