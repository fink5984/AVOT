import { expect, test } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/* A book sold in the old system: one action on the book page, then it lives in "נמכרו" and leaves the active stock. */

test("סימון ספר כנמכר במערכת הישנה: מחלון קצר אחד, יוצא מהמלאי הפעיל, מופיע ב'נמכרו' בלי מחיר ובלי לקוח", async ({ page }) => {
  await login(page);
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  const title = `ספר ישן ${Date.now()}`;
  const created = await page.request.post("/api/inventory", { data: { title, consignorId: consignor.id }, headers: { origin } });
  expect(created.ok()).toBeTruthy();
  const { item } = (await created.json()) as { item: { id: string; inventoryNumber: string } };

  // active stock: the book is listed
  await page.goto(`/inventory?q=${encodeURIComponent(title)}`);
  await expect(page.locator("tbody tr", { hasText: title })).toHaveCount(1);

  // the action is in "פעולות נוספות" on the book page
  await page.goto(`/inventory/${item.id}`);
  await page.getByRole("button", { name: /פעולות נוספות/ }).click();
  await page.getByRole("menuitem", { name: "סמן כנמכר במערכת הישנה" }).click();
  const dialog = page.getByRole("dialog", { name: "סימון ספר כנמכר במערכת הישנה" });
  await expect(dialog).toContainText("הספר נמכר במכירה קודמת שנוהלה מחוץ למערכת AVOT");
  // nothing is asked for: no price, no lot, no customer
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "אישור - סמן כנמכר" }).click();
  await expect(page.getByText("הספר סומן כנמכר במערכת הישנה")).toBeVisible();

  // the book page shows the old sale with unknown price and buyer
  await expect(page.getByText("מכירה ישנה").first()).toBeVisible();
  await expect(page.getByText("לא ידוע").first()).toBeVisible();

  // gone from the active stock list, present in "נמכרו" with the old-sale mark
  await page.goto(`/inventory?q=${encodeURIComponent(title)}`);
  await expect(page.locator("tbody tr", { hasText: title })).toHaveCount(0);
  await page.goto(`/sold?q=${encodeURIComponent(item.inventoryNumber)}`);
  const row = page.locator("tbody tr", { hasText: title });
  await expect(row).toContainText("מכירה ישנה");
  await expect(row).toContainText("מחיר לא ידוע");
  await expect(row).toContainText("לא ידוע");

  // a second marking is refused with an explanation (no second sale)
  await page.goto(`/inventory/${item.id}`);
  await page.getByRole("button", { name: /פעולות נוספות/ }).click();
  await page.getByRole("menuitem", { name: "סמן כנמכר במערכת הישנה" }).click();
  await expect(page.getByText("לא ניתן לסמן את הספר כנמכר במערכת הישנה")).toBeVisible();
});

test("phone width: the old-sale row is a card and nothing overflows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/sold");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
