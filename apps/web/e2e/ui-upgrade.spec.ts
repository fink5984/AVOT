import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/*
 * The interface upgrade: instant list search and the filter window, the one-scroll-area frame, the grouped sidebar,
 * and the alignment of headers and values.
 */

const RUN = Date.now().toString().slice(-7);

async function createBooks(page: Page, titles: string[]) {
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  for (const title of titles) {
    const r = await page.request.post("/api/inventory", { data: { title, consignorId: consignor.id }, headers: { origin } });
    expect(r.ok(), title).toBeTruthy();
  }
}
const rowsOf = (page: Page) => page.locator("table tbody tr");

test("חיפוש ברשימת המלאי: מסנן בזמן ההקלדה, מילים בכל סדר, בלי Enter ובלי הצעות, כפתור X, איפוס הכול", async ({ page }) => {
  await login(page);
  const T = `זרגל${RUN}`;
  await createBooks(page, [`נועם אלימלך ${T}`, `אלימלך שלמה ${T} נועם`, `${T} ספר אחר`]);

  await page.goto("/inventory");
  const box = page.getByTestId("list-search");
  // words in another order than the titles; nothing pressed but the keys
  await box.pressSequentially(`נועם ${T} אלימלך`, { delay: 25 });
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(page).toHaveURL(/q=/);
  // a list search never opens a book by itself and never shows a suggestions list to pick from
  await expect(page).toHaveURL(/\/inventory\?/);
  await expect(page.getByRole("listbox")).toHaveCount(0);

  // typing on: only the matches that still fit stay
  await box.fill(`${T}`);
  await expect(rowsOf(page)).toHaveCount(3);

  // the X clears the text only; a filter chosen separately stays
  await page.getByTestId("list-filter-button").click();
  const dialog = page.getByRole("dialog", { name: "סינון" });
  await dialog.getByRole("button", { name: "טרם צולם" }).click();
  await dialog.getByRole("button", { name: "בצילום" }).click(); // several values in one group
  await dialog.getByTestId("filter-apply").click();
  await expect(page.getByTestId("active-filters")).toContainText("צילום: טרם צולם");
  await expect(page.getByTestId("active-filters")).toContainText("צילום: בצילום");
  await expect(rowsOf(page)).toHaveCount(3);
  await page.getByTestId("list-search-clear").click();
  await expect(box).toHaveValue("");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page).toHaveURL(/photo=/);
  await expect(page.getByTestId("active-filters")).toContainText("צילום: טרם צולם");

  // a chip removes only its own filter
  await page.getByRole("button", { name: "הסרת הסינון: צילום: בצילום" }).click();
  await expect(page.getByTestId("active-filters")).not.toContainText("צילום: בצילום");
  await expect(page.getByTestId("active-filters")).toContainText("צילום: טרם צולם");

  // a filter that matches nothing from another group (AND between groups)
  await box.fill(T);
  await expect(rowsOf(page)).toHaveCount(3);
  await page.getByTestId("list-filter-button").click();
  await dialog.getByRole("button", { name: "מאושר" }).click();
  await dialog.getByTestId("filter-apply").click();
  await expect(rowsOf(page)).toHaveCount(0);

  // reset all: text, filters, back to the ordinary list
  await page.getByTestId("list-reset").click();
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("active-filters")).toHaveCount(0);
  await expect(page).toHaveURL(/\/inventory$/);
  expect(await rowsOf(page).count()).toBeGreaterThan(3);
});

test("חיפוש: חזרה מדף ספר שומרת את החיפוש והסינון; תשובה ישנה לא דורסת חדשה; חיפוש חל על כל העמודים", async ({ page }) => {
  await login(page);
  const T = `מחדר${RUN}`;
  await createBooks(page, [`${T} א`, `${T} ב`, `${T} ג`]);

  await page.goto("/inventory");
  const box = page.getByTestId("list-search");
  // quick typing and correcting: the screen must end on the last text's result, never on an older one
  await box.pressSequentially("ספר", { delay: 10 });
  await box.fill(`${T} ב`);
  await expect(rowsOf(page)).toHaveCount(1);
  await page.waitForTimeout(700);
  await expect(rowsOf(page)).toHaveCount(1);

  // open the book, come back: the same search
  await rowsOf(page).first().getByRole("link", { name: `${T} ב` }).click();
  await expect(page).toHaveURL(/\/inventory\/[0-9a-f-]{36}/);
  await page.goBack();
  await expect(box).toHaveValue(`${T} ב`);
  await expect(rowsOf(page)).toHaveCount(1);

  // the search is the database's, over every page (page size 2 still reports all matches)
  const res = await page.request.get(`/api/inventory?q=${encodeURIComponent(T)}&pageSize=2&page=2`);
  const body = (await res.json()) as { total: number; items: unknown[] };
  expect(body.total).toBe(3);
  expect(body.items).toHaveLength(1);

  // and the global search still navigates (it keeps its suggestions)
  await page.getByRole("searchbox", { name: "חיפוש גלובלי" }).fill(T);
  await expect(page.getByRole("listbox", { name: "תוצאות חיפוש" })).toBeVisible();
});

test("סיידבר: קבוצות נפתחות ונסגרות, קטלוגים סגורים כברירת מחדל, בלי קטלוגים בודדים, הדגשת הדף הפעיל", async ({ page }) => {
  await login(page);
  await page.goto("/inventory");
  const nav = page.getByTestId("sidebar-nav");
  const group = (id: string) => page.getByTestId(`nav-group-${id}`);

  // the group of the current page is open and marked; the catalogs group is closed
  await expect(group("stock").getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "מלאי ספרים" })).toHaveAttribute("aria-current", "page");
  await expect(group("catalogs").getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(group("catalogs").getByRole("link")).toHaveCount(0);

  // a click opens, another closes
  await group("catalogs").getByRole("button").click();
  await expect(group("catalogs").getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(group("catalogs").getByRole("link", { name: "כל הקטלוגים" })).toBeVisible();
  await expect(group("catalogs").getByRole("link", { name: "אבות" })).toBeVisible();
  await expect(group("catalogs").getByRole("link", { name: "טבין" })).toBeVisible();
  // houses and the "all" page only: never the individual catalogs
  expect(await group("catalogs").getByRole("link").count()).toBeLessThanOrEqual(3);
  await group("catalogs").getByRole("button").click();
  await expect(group("catalogs").getByRole("link")).toHaveCount(0);

  // the choice is remembered while working
  await group("catalogs").getByRole("button").click();
  await page.reload();
  await expect(group("catalogs").getByRole("button")).toHaveAttribute("aria-expanded", "true");

  // navigating into a closed group opens it
  await page.goto("/sold");
  await expect(group("sales").getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "נמכרו" })).toHaveAttribute("aria-current", "page");
});

test("סיידבר: עובד מחסן רואה רק את מה שהיה מיועד לו, גם אחרי הקיבוץ", async ({ page, browser }) => {
  await login(page);
  const email = `wh${Date.now()}@avot.local`;
  const invite = await page.request.post("/api/users/invite", { data: { name: "עובד מחסן בדיקה", email, role: "WAREHOUSE" }, headers: { origin: new URL(page.url()).origin } });
  expect(invite.status()).toBe(201);
  const { url } = await invite.json();
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  const wh = await ctx.newPage();
  await wh.goto(new URL(url).pathname);
  await wh.getByLabel("סיסמה חדשה").fill("warehouse-password-123");
  await wh.getByLabel("אימות סיסמה").fill("warehouse-password-123");
  await wh.getByRole("button", { name: "הפעלת החשבון" }).click();
  await expect(wh.getByRole("searchbox", { name: "חיפוש גלובלי" })).toBeVisible();
  // open every group the worker has, then list every link
  for (const b of await wh.getByTestId("sidebar-nav").getByRole("button").all()) if ((await b.getAttribute("aria-expanded")) === "false") await b.click();
  const links = await wh.getByTestId("sidebar-nav").getByRole("link").allInnerTexts();
  const names = links.map((l) => l.trim());
  expect(names).toEqual(expect.arrayContaining(["לוח עבודה", "מחסן", "מסופון", "יומן סריקות", "משלוחים", "מלאי ספרים", "הגדרות"]));
  for (const hidden of ["צילום", "מפקידים", "לקוחות", "נמכרו", "כל הקטלוגים", "אבות", "טבין", "דוחות", "סל מחזור", "ייבוא וייצוא"]) expect(names, hidden).not.toContain(hidden);
  await ctx.close();
});

test("גלילה במחשב: החלון עצמו לא נגלל, אזור התוכן נגלל, הסיידבר נגלל לבדו ולא מזיז את התוכן", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await login(page);
  await page.goto("/inventory");
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => {
    const main = document.querySelector("[data-app-scroll]") as HTMLElement;
    return { win: document.documentElement.scrollHeight - innerHeight, bodyY: scrollY, mainOverflow: main.scrollHeight - main.clientHeight };
  });
  expect(m.win).toBeLessThanOrEqual(0); // no second scrollbar on the window
  expect(m.mainOverflow).toBeGreaterThan(0); // the content area is the one that scrolls

  // the header and the global search stay in place while the content scrolls
  const searchTop = (await page.getByRole("searchbox", { name: "חיפוש גלובלי" }).boundingBox())!.y;
  await page.locator("[data-app-scroll]").evaluate((e) => (e.scrollTop = 600));
  expect((await page.getByRole("searchbox", { name: "חיפוש גלובלי" }).boundingBox())!.y).toBe(searchTop);

  // a short window: open every group so the sidebar is taller than the window, scroll it, the content stays
  for (const b of await page.getByTestId("sidebar-nav").getByRole("button").all()) if ((await b.getAttribute("aria-expanded")) === "false") await b.click();
  await page.locator("[data-app-scroll]").evaluate((e) => (e.scrollTop = 120));
  const nav = page.getByTestId("sidebar-nav");
  const navScrolls = await nav.evaluate((e) => e.scrollHeight > e.clientHeight);
  expect(navScrolls).toBe(true);
  await nav.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  expect(await nav.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator("[data-app-scroll]").evaluate((e) => e.scrollTop)).toBe(120);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("גלילה במובייל: הדף נגלל רגיל, אין גלילה רוחבית, התפריט נפתח כמגירה ונסגר אחרי ניווט", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await login(page);
  await page.goto("/inventory");
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "פתיחת תפריט" }).click();
  await page.getByTestId("nav-group-sales").getByRole("button").click();
  await page.getByTestId("nav-group-sales").getByRole("link", { name: "נמכרו" }).click();
  await expect(page).toHaveURL(/\/sold/);
  await expect(page.locator("#app-sidebar")).toBeHidden();
});

test("יישור: כותרות וערכים באותה עמודה, וכרטיסי הסיכום, מיושרים לאותו צד", async ({ page }) => {
  await login(page);
  // summary cards on "נמכרו": the label and its value share a right edge (RTL start)
  await page.goto("/sold");
  const cards = page.getByTestId("sold-summary").locator("> div");
  const n = await cards.count();
  expect(n).toBeGreaterThan(2);
  for (let i = 0; i < n; i++) {
    const label = await cards.nth(i).locator("div").first().boundingBox();
    const value = await cards.nth(i).locator(".num").first().boundingBox();
    expect(Math.abs((label!.x + label!.width) - (value!.x + value!.width)), `card ${i}`).toBeLessThan(24);
  }
  // tables: a numeric cell starts on the same side as its header
  for (const url of ["/customers", "/houses"]) {
    await page.goto(url);
    const th = page.locator("table thead th").nth(3);
    const td = page.locator("table tbody tr").first().locator("td").nth(3);
    if (!(await td.count())) continue;
    const cellAlign = await td.evaluate((e) => getComputedStyle(e).textAlign);
    const headAlign = await th.evaluate((e) => getComputedStyle(e).textAlign);
    expect(["right", "start"]).toContain(cellAlign);
    expect(["right", "start"]).toContain(headAlign);
  }
});
