import { expect, test } from "@playwright/test";
import { apiConsignor, createCatalog, login } from "./helpers";

/** The lots of a catalog show the review state of each book (from the inventory), can be filtered and sorted by it, and become cards on a phone. */
test.describe("catalog lots: review state", () => {
  async function setup(page: import("@playwright/test").Page) {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד E2E-קטלוג-בדיקה");
    const { catalogId } = await createCatalog(page, `קטלוג בדיקה E2E ${Date.now()}`);
    const mk = async (title: string) => {
      const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title, author: "מחבר", consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
      expect(r.ok()).toBeTruthy();
      return (await r.json()).lot as { id: string; inventoryItemId: string };
    };
    const a = await mk("ספר ממתין לבדיקה");
    const b = await mk("ספר בבדיקה");
    const c = await mk("ספר מאושר");
    const post = (id: string, data: unknown) => page.request.post(`/api/inventory/${id}/review`, { data, headers: { origin } });
    await post(b.inventoryItemId, { action: "start" });
    await post(c.inventoryItemId, { action: "start" });
    const v = (await (await page.request.get(`/api/inventory/${c.inventoryItemId}`)).json()).item.detailsVersion as number;
    expect((await post(c.inventoryItemId, { action: "approve", detailsVersion: v })).ok()).toBeTruthy();
    return { catalogId, a, b, c };
  }

  test("status, who approved, filter and sort by review state", async ({ page }) => {
    const { catalogId } = await setup(page);
    await page.goto(`/catalogs/${catalogId}`);
    const table = page.locator("table");
    await expect(table.getByText("מאושר", { exact: true })).toBeVisible();
    await expect(table.getByText("בבדיקה", { exact: true })).toBeVisible();
    await expect(table.getByText(/מאושר - /)).toBeVisible();

    await page.getByLabel("סינון לפי מצב בדיקת פרטים").selectOption("APPROVED");
    await expect(table.getByRole("link", { name: "ספר מאושר" })).toBeVisible();
    await expect(table.getByRole("link", { name: "ספר בבדיקה" })).toHaveCount(0);
    await page.getByLabel("סינון לפי מצב בדיקת פרטים").selectOption("ALL");

    await page.getByLabel("מיון").selectOption("review");
    const first = await table.locator("tbody tr").first().innerText();
    expect(first).toContain("ספר בבדיקה"); // nothing waits for review here: in-review books come before approved ones
    const last = await table.locator("tbody tr").last().innerText();
    expect(last).toContain("ספר מאושר");
  });

  for (const width of [320, 390]) {
    test(`phone cards at ${width}px: no sideways scroll, actions reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { catalogId } = await setup(page);
      await page.goto(`/catalogs/${catalogId}`);
      await expect(page.locator("table")).toBeHidden();
      const card = page.locator("ul li", { hasText: "ספר מאושר" }).first();
      await expect(card.getByText("מאושר", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: /פעולות לפריט/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "סינון ומיון" }).click();
      await expect(page.getByLabel("סינון לפי מצב בדיקת פרטים")).toBeVisible();
    });
  }
});
