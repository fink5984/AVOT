import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, createCatalog, login } from "./helpers";

/* Starting prices, sale-results import, customers, "נמכרו", smart shipping hints, finishing a sale - through the real screens. */

async function addLot(page: Page, catalogId: string, title: string) {
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
  expect(r.ok()).toBeTruthy();
}

test("starting price: inline edit, counters, missing-price filter, Excel warning (desktop)", async ({ page }) => {
  await login(page);
  const { catalogId } = await createCatalog(page, "מחירי פתיחה E2E");
  for (const t of ["נועם אלימלך", "שו״ת חתם סופר", "ספר חדש"]) await addLot(page, catalogId, t);
  await page.goto(`/catalogs/${catalogId}`);
  await expect(page.getByTestId("price-summary")).toContainText("3 לוטים");
  await expect(page.getByTestId("price-summary")).toContainText("0 עם מחיר");

  // click the price, type, Enter
  const first = page.locator("tbody tr").first();
  await first.getByRole("button", { name: /לא הוגדר/ }).click();
  await page.getByLabel("מחיר פתיחה בדולרים").fill("150");
  await page.getByLabel("מחיר פתיחה בדולרים").press("Enter");
  await expect(first.getByRole("button", { name: /\$150/ })).toBeVisible();
  await expect(page.getByTestId("price-summary")).toContainText("1 עם מחיר");
  await expect(page.getByTestId("price-summary")).toContainText("2 ללא מחיר");

  // zero is refused and the last saved value comes back
  await first.getByRole("button", { name: /\$150/ }).click();
  await page.getByLabel("מחיר פתיחה בדולרים").fill("0");
  await page.getByLabel("מחיר פתיחה בדולרים").press("Enter");
  await expect(page.getByText("הסכום חייב להיות גדול מאפס")).toBeVisible();
  await expect(first.getByRole("button", { name: /\$150/ })).toBeVisible();

  // only lots without a price
  await page.getByLabel("הצג רק לוטים ללא מחיר").check();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("הצג רק לוטים ללא מחיר").uncheck();

  // the whole-catalog Excel export (not the filtered table)
  const res = await page.request.get(`/api/catalogs/${catalogId}/export-xlsx`);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["x-avot-lots"]).toBe("3");
  expect(res.headers()["x-avot-missing-prices"]).toBe("2");
});

test("sale results import → customers → נמכרו → smart shipping hint → finishing the sale", async ({ page }) => {
  await login(page);
  const { catalogId, number } = await createCatalog(page, "תוצאות E2E");
  for (const t of ["ספר א", "ספר ב", "ספר ג", "ספר ד"]) await addLot(page, catalogId, t);
  await page.goto(`/catalogs/${catalogId}`);

  const stamp = Date.now();
  const csv = ["Lot,Status,Hammer Price,Bidder,Name,Email", `1,Sold,300,5,יצחק כהן,yk${stamp}@example.com`, `2,Sold,200,5,יצחק כהן,yk${stamp}@example.com`, `3,Sold,100,6,דנה לוי,dl${stamp}@example.com`, `4,Unsold,,,,`].join("\n");
  await page.getByRole("button", { name: "עוד" }).click();
  await page.getByRole("menuitem", { name: "ייבוא תוצאות מכירה" }).click();
  const dialog = page.getByRole("dialog", { name: "ייבוא תוצאות מכירה" });
  await dialog.getByLabel("קובץ תוצאות").setInputFiles({ name: "results.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
  await dialog.getByRole("button", { name: "העלאה ובדיקה" }).click();
  const summary = dialog.getByTestId("import-summary");
  await expect(summary).toContainText("לקוחות חדשים");
  await expect(summary.getByText("נמכרו", { exact: true }).locator("..")).toContainText("3");
  await dialog.getByRole("button", { name: /אישור וקליטה/ }).click();
  await expect(page.getByText(/הייבוא נקלט/)).toBeVisible();

  // נמכרו: the three lots, with buyer and the financial / physical states separate
  await page.goto(`/sold?q=${encodeURIComponent(number)}`);
  await expect(page.getByTestId("sold-summary")).toContainText("3");
  const row = page.locator("tbody tr", { hasText: "ספר א" });
  await expect(row).toContainText("יצחק כהן");
  await expect(row).toContainText("ממתין לתשלום");
  await expect(row).toContainText("ממתין לשחרור");

  // the customer page shows both purchases and the open balance
  await row.getByRole("link", { name: "יצחק כהן" }).click();
  await expect(page.getByTestId("customer-summary")).toContainText("$500");
  await expect(page.getByText("ספר ב").first()).toBeVisible();

  // pay in full and release both lots
  await page.getByRole("button", { name: "רישום תשלום" }).click();
  const pay = page.getByRole("dialog", { name: "רישום תשלום" });
  await pay.getByLabel("סכום (דולר)").fill("500");
  await pay.getByRole("button", { name: "רישום" }).click();
  await expect(page.getByText("התשלום נרשם")).toBeVisible();
  const release = page.getByRole("button", { name: "שחרור", exact: true });
  await expect(release).toHaveCount(2);
  // a click right after a refresh can land before the page is interactive: retry until the lot is released
  await expect(async () => {
    await release.first().click({ timeout: 3000 });
    await expect(release).toHaveCount(1, { timeout: 5000 });
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    await release.first().click({ timeout: 3000 });
    await expect(release).toHaveCount(0, { timeout: 5000 });
  }).toPass({ timeout: 30_000 });

  // from "נמכרו": preparing a shipment for ONE lot says the customer bought one more
  await page.goto(`/sold?q=${encodeURIComponent("ספר א")}`);
  await page.getByRole("button", { name: "הכנה למשלוח" }).first().click();
  const prep = page.getByRole("dialog", { name: /הכנה למשלוח/ });
  await expect(prep.getByTestId("more-purchases")).toContainText("רכש עוד 1 לוטים");
  // sending only one lot asks first
  await prep.getByRole("button", { name: /יצירת משלוח/ }).click();
  await expect(prep.getByText(/ללקוח יש עוד 1 לוטים שעדיין לא נשלחו/)).toBeVisible();
  await prep.getByRole("button", { name: "חזרה ובחירת פריטים נוספים" }).click();
  await prep.getByRole("button", { name: "צרף את כל הפריטים הזמינים" }).click();
  await prep.getByRole("button", { name: /יצירת משלוח/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /משלוח \d+/ })).toBeVisible();
  // creating the shipment did not ship anything
  await expect(page.getByText("בהכנה").first()).toBeVisible();

  // finishing the sale: the numbers, and the unknown-result rule
  await page.goto(`/catalogs/${catalogId}`);
  await page.getByRole("button", { name: "עוד" }).click();
  await page.getByRole("menuitem", { name: "סיום מכירה" }).click();
  const fin = page.getByRole("dialog", { name: "סיום מכירה" });
  await expect(fin.getByTestId("finish-summary")).toContainText("3");
  await fin.getByLabel("טיפול בלוטים שלא נמכרו").selectOption("HOLD_POST_SALE");
  await fin.getByRole("button", { name: "סיום המכירה" }).click();
  await expect(page.getByText("המכירה הסתיימה")).toBeVisible();
});

test("phone width: the sold list is cards and the customers page opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/sold");
  await expect(page.getByRole("heading", { level: 1, name: "נמכרו" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.goto("/customers");
  await expect(page.getByRole("heading", { level: 1, name: "לקוחות" })).toBeVisible();
  await page.goto("/shipments");
  await expect(page.getByRole("heading", { level: 1, name: "משלוחים" })).toBeVisible();
});
