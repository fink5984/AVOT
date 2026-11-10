import { expect, test } from "@playwright/test";
import { apiConsignor, createCatalog, login } from "./helpers";

/**
 * Combined lots, through the real UI: select books in a catalog, "איחוד ללוט", the lot page ("הספרים בלוט", shared
 * gallery, shared description with its AI button), a refused merge (different consignors) and "פירוק הלוט".
 * The AI call itself is covered by the integration tests with a fake provider (no network here).
 */
test.describe("combined lots", () => {
  test("merge two books into one lot, see the lot page, dissolve it", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const anna = await apiConsignor(page, "אנה E2E-איחוד");
    const boaz = await apiConsignor(page, "בועז E2E-איחוד");
    const { catalogId } = await createCatalog(page, "קטלוג איחוד E2E");
    const add = async (title: string, consignorId: string) => {
      const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title, consignorId, opId: crypto.randomUUID() }, headers: { origin } });
      expect(r.ok()).toBeTruthy();
      return (await r.json()).lot as { id: string; lotNumber: number };
    };
    const a = await add("ספר א של אנה", anna.id);
    const b = await add("ספר ב של אנה", anna.id);
    const c = await add("ספר ג של אנה", anna.id);
    const d = await add("ספר ד של בועז", boaz.id);

    await page.goto(`/catalogs/${catalogId}`);
    const rowOf = (n: number) => page.getByRole("row").filter({ has: page.getByLabel(`בחירת פריט ${n}`) });

    // different consignors: the dialog says so and the confirm button is disabled
    await page.getByLabel(`בחירת פריט ${a.lotNumber}`).check();
    await page.getByLabel(`בחירת פריט ${d.lotNumber}`).check();
    await page.getByRole("button", { name: "איחוד ללוט" }).click();
    const dialog = page.getByRole("dialog", { name: "איחוד ללוט" });
    await expect(dialog.getByText("לא ניתן לאחד ספרים ממפקידים שונים. כל הספרים בלוט משולב חייבים להשתייך לאותו מפקיד.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^איחוד 2 ספרים/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "ביטול" }).click();
    await page.getByLabel(`בחירת פריט ${d.lotNumber}`).uncheck();

    // merge a + b + c, keep the middle lot number
    await page.getByLabel(`בחירת פריט ${b.lotNumber}`).check();
    await page.getByLabel(`בחירת פריט ${c.lotNumber}`).check();
    await page.getByRole("button", { name: "איחוד ללוט" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio").nth(1).check();
    await dialog.getByLabel("כותרת משותפת (לא חובה)").fill("שלושה ספרים של אנה");
    await dialog.getByRole("button", { name: /^איחוד 3 ספרים ללוט/ }).click();
    await expect(page.getByText("נוצר לוט משולב: פריט 1 · 3 ספרים")).toBeVisible();

    // the catalog shows ONE row for the combined lot; the absorbed lots are gone from the table, other lots keep their numbers
    // the numbers close up: the combined lot is 1 and the other lot is 2 (no gaps)
    await expect(rowOf(1).getByText("3 ספרים")).toBeVisible();
    await expect(rowOf(2).getByText("ספר ד של בועז")).toBeVisible();
    await expect(page.getByLabel("בחירת פריט 3")).toHaveCount(0);

    // the lot page
    await rowOf(1).getByRole("link", { name: "שלושה ספרים של אנה" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "שלושה ספרים של אנה" })).toBeVisible();
    await expect(page.getByText("לוט משולב ·").first()).toBeVisible();
    await expect(page.getByText("הספרים בלוט")).toBeVisible();
    await expect(page.getByText("ספר א של אנה").first()).toBeVisible();
    await expect(page.getByText("ספר ג של אנה").first()).toBeVisible();
    await expect(page.getByText("גלריה משותפת")).toBeVisible();
    await expect(page.getByRole("button", { name: "יצירת תיאור משותף ב-AI" })).toBeVisible();
    await expect(page.getByRole("button", { name: "הוסף ספר ללוט" })).toBeVisible();
    await expect(page.getByRole("button", { name: "פירוק הלוט" })).toBeVisible();
    await expect(page.getByText("התיאור המשותף דורש עדכון")).toHaveCount(0); // no description existed

    // manual shared description
    await page.getByRole("button", { name: "עריכת כותרת ותיאור" }).click();
    const edit = page.getByRole("dialog", { name: "כותרת ותיאור משותפים" });
    await edit.getByLabel("תיאור קטלוגי משותף").fill("שלושה ספרים מאוסף אחד.");
    await edit.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByText("שלושה ספרים מאוסף אחד.").first()).toBeVisible();

    // remove one book: back to its own lot, the description is flagged as needing an update
    await page.getByRole("button", { name: /הסרת ספר ג של אנה מהלוט/ }).click();
    const removeDlg = page.getByRole("dialog", { name: "הסרת ספר מהלוט" });
    await removeDlg.getByRole("button", { name: "הסרה מהלוט" }).click();
    await expect(page.getByText("התיאור המשותף דורש עדכון").first()).toBeVisible();
    await expect(page.getByText("הספרים בלוט").first()).toBeVisible();

    // add the book back from the dialog, then dissolve
    await page.getByRole("button", { name: "הוסף ספר ללוט" }).click();
    const addDlg = page.getByRole("dialog", { name: "הוסף ספר ללוט" });
    await expect(addDlg.getByText("ספר ג של אנה")).toBeVisible();
    await expect(addDlg.getByText("ספר ד של בועז")).toHaveCount(0); // another consignor is never offered
    await addDlg.getByText("ספר ג של אנה").click();
    await addDlg.getByRole("button", { name: /^הוספת/ }).click();
    await expect(page.getByText("נוספו 1 ספרים ללוט")).toBeVisible();

    await page.getByRole("button", { name: "פירוק הלוט" }).click();
    await page.getByRole("dialog", { name: /פירוק לוט \d+/ }).getByRole("button", { name: "פירוק הלוט" }).click();
    await expect(page.getByText("הלוט פורק: כל ספר חזר להיות פריט נפרד")).toBeVisible();

    await page.goto(`/catalogs/${catalogId}`);
    for (const n of [1, 2, 3, 4]) await expect(page.getByLabel(`בחירת פריט ${n}`)).toBeVisible();
  });
});
