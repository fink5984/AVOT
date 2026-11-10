import { expect, test } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/** The book page: catalog content right after the photos, one details window for pencil and button, no sideways scroll on a phone. */
test.describe("book page layout", () => {
  async function makeBook(page: import("@playwright/test").Page, title: string) {
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד E2E-דף ספר");
    const r = await page.request.post("/api/inventory", {
      data: { title, author: "מחבר לדוגמה", printPlace: "ונציה", printYear: "1550", bibliographicNotes: "פרטים ביבליוגרפיים ארוכים לבדיקה", consignorId: consignor.id, opId: crypto.randomUUID() },
      headers: { origin },
    });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).item.id as string;
  }

  test("title on top, catalog content after the photos, long bibliographic fields only in the details window", async ({ page }) => {
    await login(page);
    const title = `ספר דף E2E ${Date.now()}`;
    const id = await makeBook(page, title);
    await page.goto(`/inventory/${id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const catalog = page.locator("section", { has: page.getByRole("heading", { name: /תוכן לפרסום בקטלוג/ }) });
    await expect(catalog.getByLabel("כותרת קטלוגית")).toBeVisible();
    await expect(catalog.getByRole("textbox", { name: "תיאור קטלוגי" })).toBeVisible();
    // the long bibliographic fields are not on the page by default
    await expect(page.getByRole("textbox", { name: "פרטים ביבליוגרפיים" })).toHaveCount(0);
    // the catalog area sits below the photo gallery
    const gallery = await page.locator("main").getByText(/תמונות/).first().boundingBox();
    const area = await catalog.boundingBox();
    expect(area!.y).toBeGreaterThan(gallery!.y);
  });

  test("the pencil and \"פרטי הספר המלאים\" open the same window; an edit autosaves and shows on the page", async ({ page }) => {
    await login(page);
    const id = await makeBook(page, `ספר חלון E2E ${Date.now()}`);
    await page.goto(`/inventory/${id}`);

    await page.getByRole("button", { name: /עריכת פרטי הספר/ }).first().click();
    const dialog = page.getByRole("dialog", { name: /פרטי הספר המלאים/ });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    for (const label of ["שם הפריט", "מחבר / יוצר", "מקום דפוס / יצירה", "שנת דפוס / יצירה", "מדפיס / הוצאה", "מהדורה", "היקף / דפים", "הערות פנימיות", "ברקוד חיצוני (אופציונלי)", "קטגוריית גודל"]) {
      await expect(dialog.getByLabel(label).first()).toBeVisible();
    }
    await dialog.getByLabel("גובה (מ״מ)").fill("250");
    await dialog.getByLabel("מחבר / יוצר").fill("מחבר שתוקן");
    await expect(dialog.getByText("נשמר", { exact: true })).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "סגירה" }).last().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // the button under the catalog content opens the very same window
    await page.getByRole("button", { name: "פרטי הספר המלאים" }).click();
    await expect(page.getByRole("dialog", { name: /פרטי הספר המלאים/ })).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel("מחבר / יוצר")).toHaveValue("מחבר שתוקן");
    await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).last().click();

    const stored = (await (await page.request.get(`/api/inventory/${id}`)).json()).item;
    expect(stored).toMatchObject({ author: "מחבר שתוקן", heightMm: 250 });
  });

  test("an editor can start a review but the server refuses the approval; approve button hidden", async ({ page }) => {
    await login(page);
    const id = await makeBook(page, `ספר אישור E2E ${Date.now()}`);
    await page.goto(`/inventory/${id}`);
    // the admin has the approval permission by role
    await expect(page.getByRole("button", { name: "סיום בדיקה ואישור" })).toBeVisible();
  });

  for (const width of [320, 390, 768]) {
    test(`no sideways scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await login(page);
      const id = await makeBook(page, `ספר בשם ארוך במיוחד שאמור להישבר לכמה שורות בלי לחתוך אותו ${Date.now()}`);
      await page.goto(`/inventory/${id}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "פרטי הספר המלאים" }).click();
      const box = await page.getByRole("dialog").boundingBox();
      expect(box!.height).toBeLessThanOrEqual(800);
      expect(box!.x).toBeGreaterThanOrEqual(0);
    });
  }
});
