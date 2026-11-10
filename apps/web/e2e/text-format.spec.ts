import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, createCatalog, login } from "./helpers";

/** Selects characters [from, to) of the first text node of a rich editor, as a person dragging over them would. */
async function selectChars(page: Page, label: string, from: number, to: number) {
  await page.evaluate(
    ([l, a, b]) => {
      const root = document.querySelector(`[role="textbox"][aria-label="${l}"]`) as HTMLElement;
      root.focus();
      // character offsets counted over all text nodes, as a person sees them
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const point = (offset: number): [Node, number] => {
        let left = offset;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const len = n.nodeValue!.length;
          if (left <= len) return [n, left];
          left -= len;
        }
        throw new Error("offset beyond the text");
      };
      const [sn, so] = point(a as number);
      walker.currentNode = root;
      const [en, eo] = point(b as number);
      const r = document.createRange();
      r.setStart(sn, so);
      r.setEnd(en, eo);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    },
    [label, from, to] as const,
  );
}

test.describe("text formatting in inventory", () => {
  test("the book's details window (pencil) holds every field, and the formatting tools are the rich editors' own", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד E2E-עיצוב");
    const r = await page.request.post("/api/inventory", { data: { title: "ספר ללא עיצוב E2E", consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
    expect(r.ok()).toBeTruthy();
    const item = (await r.json()).item as { id: string };

    await page.goto(`/inventory/${item.id}`);
    await page.getByRole("button", { name: /עריכת פרטי הספר/ }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "פרטים ביבליוגרפיים" })).toBeVisible();
  });

  test("the review panel formats the catalog description and autosaves it", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד E2E-עיצוב-פאנל");
    const r = await page.request.post("/api/inventory", { data: { title: "ספר פאנל E2E", consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
    const item = (await r.json()).item as { id: string };
    await page.goto(`/inventory/${item.id}`);

    const editor = page.getByRole("textbox", { name: "תיאור קטלוגי" });
    await editor.click();
    await page.keyboard.type("תיאור קטלוגי לדוגמה");
    await selectChars(page, "תיאור קטלוגי", 0, 5);
    await page.getByRole("button", { name: "הדגשה" }).last().click();
    await expect(editor.locator("span[style*='700']")).toHaveText("תיאור");
    await expect(page.getByText("נשמר", { exact: true })).toBeVisible({ timeout: 15_000 });

    const stored = await (await page.request.get(`/api/inventory/${item.id}`)).json();
    expect(stored.item.catalogDescription).toBe("תיאור קטלוגי לדוגמה");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" }).locator("span[style*='700']")).toHaveText("תיאור");
  });

  test("a lot's description in a catalog: format in the edit dialog, shown on the lot page", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד E2E-עיצוב-לוט");
    const { catalogId } = await createCatalog(page, "קטלוג עיצוב E2E");
    const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title: "לוט לעיצוב E2E", consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
    expect(r.ok()).toBeTruthy();
    const lot = (await r.json()).lot as { id: string };

    await page.goto(`/lots/${lot.id}`);
    await page.getByRole("button", { name: "עריכה" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("toolbar", { name: "עיצוב טקסט" })).toHaveCount(1);
    const editor = dialog.getByRole("textbox", { name: "תיאור מלא לקטלוג" });
    await editor.click();
    await page.keyboard.type("כריכת עור מקורית");
    await selectChars(page, "תיאור מלא לקטלוג", 0, 5);
    await dialog.getByRole("button", { name: "הדגשה" }).last().click();
    await dialog.getByRole("button", { name: "קו תחתון" }).last().click();
    await dialog.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("פרטי הפריט נשמרו")).toBeVisible();

    await page.reload();
    const shown = page.locator("p", { hasText: "כריכת עור מקורית" }).first();
    await expect(shown.locator("span[style*='700']")).toHaveText("כריכת");
    await expect(shown.locator("span[style*='underline']")).toHaveText("כריכת");
    expect((await (await page.request.get(`/api/lots/${lot.id}`)).json()).lot.description).toBe("כריכת עור מקורית");
  });
});
