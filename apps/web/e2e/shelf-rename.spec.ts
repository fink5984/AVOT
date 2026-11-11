import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/* Renaming a shelf from the warehouse page: pencil next to the shelf, small dialog, success / error, phone width. */

async function makeWarehouse(page: Page) {
  const origin = new URL(page.url()).origin;
  const name = `מחסן שמות ${Date.now()}`;
  const r = await page.request.post("/api/warehouse/wizard", { data: { name, columns: 2, shelvesPerColumn: 3 }, headers: { origin } });
  expect(r.ok()).toBeTruthy();
  return name;
}

for (const [label, viewport] of [["desktop", { width: 1500, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`rename a shelf from its column (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    const warehouse = await makeWarehouse(page);
    await page.goto("/warehouse");
    await page.getByRole("tab", { name: warehouse }).or(page.getByRole("button", { name: warehouse })).first().click().catch(() => undefined);

    const shelves = page.getByTestId("shelf-name");
    const first = shelves.first();
    await expect(first).toHaveText(/^מדף \d+$/);

    // the pencil opens a small window with the current name
    await page.getByRole("button", { name: /^שינוי שם מדף \d+$/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "שינוי שם מדף" });
    await expect(dialog.getByLabel("שם המדף")).toHaveValue(/^מדף \d+$/);
    // the dialog fits the screen
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);

    // a name another shelf of the column already has is refused with a clear message
    await dialog.getByLabel("שם המדף").fill("מדף 2");
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(dialog.getByText(/כבר יש מדף בשם/)).toBeVisible();

    const newName = `מדף הלכה ${Date.now() % 10000}`;
    await dialog.getByLabel("שם המדף").fill(newName);
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("שם המדף עודכן")).toBeVisible();
    await expect(page.getByTestId("shelf-name").filter({ hasText: newName })).toBeVisible();

    // no horizontal scrolling at any width
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    // and back to the default name
    await page.getByRole("button", { name: `שינוי שם ${newName}` }).click();
    await page.getByRole("dialog", { name: "שינוי שם מדף" }).getByRole("button", { name: "חזרה לשם ברירת המחדל" }).click();
    await expect(page.getByTestId("shelf-name").filter({ hasText: newName })).toHaveCount(0);
  });
}
