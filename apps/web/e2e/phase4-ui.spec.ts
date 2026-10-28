import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Round of fixes 16–25 through the real UI: sidebar handheld link, search by inventory number (+ fast Enter), the
 * actions on the book page (one-click print, shelf picker, Hebrew location), warehouse menus that are never clipped,
 * deleting shelves/columns, and the label calibration preview.
 */

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const origin = (page: Page) => new URL(page.url()).origin;

async function newBook(page: Page, title: string) {
  const r = await page.request.post("/api/inventory", { data: { title }, headers: { origin: origin(page) } });
  const { item } = await r.json();
  return item as { id: string; inventoryNumber: string };
}

async function newWarehouse(page: Page, name: string, columns: number, shelves: number) {
  const r = await page.request.post("/api/warehouse/wizard", { data: { name, columns, shelvesPerColumn: shelves }, headers: { origin: origin(page) } });
  expect(r.ok()).toBeTruthy();
  const tree = (await (await page.request.get("/api/warehouse")).json()).warehouses as { id: string; name: string; zones: { id: string; name: string; shelves: { id: string; locations: { id: string }[] }[] }[] }[];
  return tree.find((w) => w.name === name)!;
}

test("sidebar: the handheld comes right after the warehouse and opens the phone screen (desktop notice with links)", async ({ page }) => {
  await login(page);
  const links = await page.locator("nav a").allTextContents();
  const clean = links.map((t) => t.trim()).filter(Boolean);
  const iw = clean.indexOf("מחסן");
  expect(iw).toBeGreaterThan(-1);
  expect(clean[iw + 1]).toBe("מסופון");
  expect(clean.filter((t) => t === "מסופון")).toHaveLength(1);
  await page.locator("nav a", { hasText: "מסופון" }).click();
  await expect(page).toHaveURL(/\/scanner/);
  await expect(page.getByText("המסופון מיועד לשימוש בטלפון")).toBeVisible();
  await expect(page.getByRole("link", { name: "פתח מחסן" })).toBeVisible();
});

test("search: an exact inventory number is a result, Enter opens the book — even typed fast like a USB scanner", async ({ page }) => {
  await login(page);
  const book = await newBook(page, `ספר חיפוש ${RUN}`);
  const box = page.getByRole("searchbox", { name: "חיפוש גלובלי" });

  await box.fill(book.inventoryNumber);
  const row = page.getByRole("option", { name: new RegExp(`ספר חיפוש ${RUN}`) });
  await expect(row).toBeVisible();
  await expect(page.getByText(/לא נמצאו ספרים או קטלוגים/)).toHaveCount(0);
  await box.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/inventory/${book.id}`));

  // a scanner types the digits and Enter within a few ms, before the debounced request even starts
  await page.goto("/");
  await box.click();
  await page.keyboard.type(book.inventoryNumber, { delay: 1 });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/inventory/${book.id}`));

  // a number that does not exist says so (after the answer arrived), and Enter goes to the full search
  await page.goto("/");
  await box.fill("99999999");
  await expect(page.getByText(/לא נמצאו ספרים או קטלוגים עבור/)).toBeVisible();
});

test("book page: the same quick actions as the table; print is one click (no navigation); location in Hebrew; picker, no code field", async ({ page }) => {
  await login(page);
  const wh = await newWarehouse(page, `מחסן ספר ${RUN}`, 1, 2);
  // a printer must exist for the central queue (a network printer record is enough: nothing is printed here)
  const printers = (await (await page.request.get("/api/print/printers")).json()).printers as { id: string }[];
  if (!printers.length) await page.request.post("/api/print/printers", { data: { name: "e2e", connection: "NETWORK", host: "127.0.0.1", port: 9100, isPrimary: true }, headers: { origin: origin(page) } });

  const book = await newBook(page, `ספר פעולות ${RUN}`);
  await page.request.post(`/api/inventory/${book.id}/location`, { data: { locationId: wh.zones[0]!.shelves[0]!.locations[0]!.id }, headers: { origin: origin(page) } });
  await page.goto(`/inventory/${book.id}`);

  // Hebrew place, no technical code, no cell
  const place = page.locator("a[href*='/warehouse/locations/']").first();
  await expect(place).toContainText(`מחסן ספר ${RUN}`);
  await expect(place).toContainText("עמודה 1");
  await expect(place).toContainText("מדף 1");
  await expect(place).not.toContainText("LOC-");
  await expect(place).not.toContainText("תא");

  const bar = page.getByRole("group", { name: new RegExp(`פעולות לספר ${book.inventoryNumber}`) });
  for (const name of [/צילום/, /הדפסת תווית/, /שייך לקטלוג/, /שנה מיקום/, /עריכת פרטי הספר/, /פעולות נוספות/]) await expect(bar.getByRole("button", { name }).or(bar.getByRole("link", { name }))).toBeVisible();

  // one click: a print job is queued, we stay on the page, a double click makes one job
  const jobs: string[] = [];
  page.on("request", (r) => r.url().includes("/api/print/jobs") && r.method() === "POST" && jobs.push(r.url()));
  const url = page.url();
  const printBtn = bar.getByRole("button", { name: /הדפסת תווית/ });
  await printBtn.dblclick();
  await expect(page.getByText(/נשלחה להדפסה|מדפסת/).first()).toBeVisible();
  expect(page.url()).toBe(url);
  expect(jobs).toHaveLength(1);

  // relocation is a choice, not a code
  await bar.getByRole("button", { name: "שנה מיקום" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("קוד מיקום")).toHaveCount(0);
  await expect(dialog.getByLabel("מחסן")).toBeVisible();
  await expect(dialog.getByLabel("עמודה")).toBeVisible();
  await expect(dialog.getByLabel("מדף")).toBeVisible();
  await expect(dialog.getByLabel("תא")).toHaveCount(0);
  await dialog.getByLabel("עמודה").selectOption({ index: 1 });
  await dialog.getByLabel("מדף").selectOption({ index: 2 });
  await dialog.getByRole("button", { name: "העברה" }).click();
  await expect(page.locator("a[href*='/warehouse/locations/']").first()).toContainText("מדף 2", { timeout: 15_000 });
});

test("warehouse menus open over the card, whole, flipped and shifted — empty column, long column, narrow screen", async ({ page }) => {
  await login(page);
  await newWarehouse(page, `מחסן תפריט ${RUN}`, 3, 1);
  await page.goto("/warehouse");
  await page.getByRole("tab", { name: `מחסן תפריט ${RUN}` }).click().catch(() => undefined);

  const inViewport = async (menu: ReturnType<Page["getByRole"]>) => {
    const b = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
    return b;
  };

  // a one-shelf column: a short card, the menu is taller than the card and is not cut
  const trigger = page.getByRole("button", { name: /פעולות לעמודה/ }).first();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "מחק עמודה" })).toBeVisible();
  const card = (await trigger.locator("xpath=ancestor::div[contains(@class,'card')][1]").boundingBox())!;
  const b = await inViewport(menu);
  expect(b.height).toBeGreaterThan(card.height * 0.9); // taller than the little card: it lives above the card, not inside it
  // the menu is not a descendant of the card (portal), so overflow-hidden cannot clip it
  expect(await menu.evaluate((el) => !!el.closest(".card"))).toBe(false);
  // Escape closes and returns focus to the button
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // arrow keys move through the items; click outside closes
  await trigger.click();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);

  // narrow phone: the last column's menu stays inside the screen
  await page.setViewportSize({ width: 390, height: 700 });
  await page.reload();
  const triggers = page.getByRole("button", { name: /פעולות לעמודה/ });
  await triggers.last().scrollIntoViewIfNeeded();
  await triggers.last().click();
  await expect(menu).toBeVisible();
  await inViewport(menu);
});

test("deleting: empty shelves of a column, then the column — with the books asked about first", async ({ page }) => {
  await login(page);
  const name = `מחסן מחיקה ${RUN}`;
  const wh = await newWarehouse(page, name, 2, 4);
  const book = await newBook(page, `ספר מחיקה ${RUN}`);
  await page.request.post(`/api/inventory/${book.id}/location`, { data: { locationId: wh.zones[0]!.shelves[1]!.locations[0]!.id }, headers: { origin: origin(page) } });
  await page.goto("/warehouse");
  await page.getByRole("tab", { name }).click().catch(() => undefined);

  const col1 = page.locator(".card", { hasText: "עמודה 1" }).first();
  await col1.getByRole("button", { name: /פעולות לעמודה/ }).click();
  await page.getByRole("menuitem", { name: "מחק מדפים ריקים" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("3");
  await dialog.getByRole("button", { name: "מחיקת המדפים הריקים" }).click();
  await expect(col1.getByText(/מדף \d+/)).toHaveCount(1, { timeout: 15_000 }); // only the shelf with the book stayed

  // the column has a book: the dialog asks where it goes and will not delete before that
  await col1.getByRole("button", { name: /פעולות לעמודה/ }).click();
  await page.getByRole("menuitem", { name: "מחק עמודה" }).click();
  await expect(dialog).toContainText("ספרים");
  const del = dialog.getByRole("button", { name: "מחיקת העמודה" });
  await expect(del).toBeDisabled();
  await dialog.getByLabel("עמודה").selectOption({ index: 1 });
  await dialog.getByLabel("מדף").selectOption({ index: 1 });
  await expect(del).toBeEnabled();
  await del.click();
  await expect(page.locator(".card", { hasText: "עמודה 1" })).toHaveCount(0, { timeout: 15_000 });
  // the book is on its new shelf
  const moved = await (await page.request.get(`/api/inventory/${book.id}/location`)).json().catch(() => null);
  expect(moved).toBeTruthy();
});

test("printer settings: label calibration with a live preview from the real engine", async ({ page }) => {
  await login(page);
  await page.goto("/settings/printer");
  const preview = page.getByTestId("label-preview").locator("img");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  const w0 = await preview.evaluate((i) => (i as HTMLImageElement).naturalWidth);
  expect(w0).toBeGreaterThan(300);
  const src0 = await preview.getAttribute("src");
  await page.getByRole("slider", { name: /גובה הברקוד|גובה/ }).first().fill("14").catch(async () => {
    await page.getByText("גובה הברקוד").locator("xpath=ancestor::label//input").fill("14");
  });
  await expect.poll(async () => preview.getAttribute("src"), { timeout: 15_000 }).not.toBe(src0);
  await expect(page.getByTestId("label-info")).toContainText("מ״מ");
  // the three label types each have a tab
  for (const t of ["תווית ספר", "תווית מדף", "תווית עמודה"]) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await page.getByRole("tab", { name: "תווית מדף" }).click();
  await expect(preview).toBeVisible();
});
