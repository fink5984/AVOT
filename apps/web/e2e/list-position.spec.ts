import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/*
 * Working position of lists: the editor opens a book from page 3 of the inventory (or from a filtered catalog table), works,
 * comes back - and lands on the same page, with the same search / filters / sort, on the same row. A new entry from the menu
 * starts clean. Only the app's inner content area scrolls on a computer; on a phone the window does.
 */

const scroller = (page: Page) => page.locator("[data-app-scroll]");
const scrollTopOf = (page: Page) => scroller(page).evaluate((el) => el.scrollTop);

/** a row link of the inventory table that is on screen now, with its distance from the top of the scrolling area */
async function visibleBook(page: Page, index = 3) {
  return page.evaluate((i) => {
    const area = document.querySelector("[data-app-scroll]")!.getBoundingClientRect();
    const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-app-scroll] a[href^='/inventory/']")].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.top > area.top + 80 && r.bottom < area.bottom - 20 && /\/inventory\/[0-9a-f-]{36}$/.test(a.getAttribute("href")!);
    });
    const a = links[Math.min(i, links.length - 1)]!;
    return { href: a.getAttribute("href")!, offset: Math.round(a.getBoundingClientRect().top - area.top), text: a.textContent!.trim() };
  }, index);
}
const offsetOf = (page: Page, href: string) =>
  page.evaluate((h) => {
    const area = document.querySelector("[data-app-scroll]")!.getBoundingClientRect();
    const a = [...document.querySelectorAll<HTMLAnchorElement>(`[data-app-scroll] a[href='${h}']`)].find((x) => x.getBoundingClientRect().width > 0);
    return a ? Math.round(a.getBoundingClientRect().top - area.top) : null;
  }, href);

async function ensureBooks(page: Page, min: number) {
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  const list = await page.request.get("/api/inventory?pageSize=1").then((r) => r.json());
  let have = Number(list.total ?? 0);
  while (have < min) {
    const batch = Math.min(10, min - have);
    await Promise.all(Array.from({ length: batch }, (_, k) => page.request.post("/api/inventory", { data: { title: `ספר ניווט ${Date.now()}-${k}`, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } })));
    have += batch;
  }
}

test.describe("returning to a list", () => {
  test("inventory page 2 with sort: opening a book and returning by the breadcrumb, the back button of the browser, and 'back' again restores page, sort and the row", async ({ page }) => {
    await login(page);
    await ensureBooks(page, 135);
    await page.goto("/inventory?page=2&sort=number");
    await expect(page.getByRole("link", { name: /^ספר|^/ }).first()).toBeVisible();
    await scroller(page).evaluate((el) => el.scrollTo({ top: 1100 }));
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(500);
    const target = await visibleBook(page);

    // 1. a link inside the app (breadcrumb of the book page)
    await page.locator(`[data-app-scroll] a[href='${target.href}']:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`${target.href}$`), { timeout: 60_000 });
    await expect(scroller(page).getByRole("link", { name: "מלאי", exact: true }).first()).toBeVisible();
    await scroller(page).getByRole("link", { name: "מלאי", exact: true }).first().click();
    await expect(page).toHaveURL(/\/inventory\?page=2&sort=number$/);
    // the row is brought back once the page is on screen again (the restorer waits for the data, then aligns)
    await expect.poll(async () => Math.abs(((await offsetOf(page, target.href)) ?? 99999) - target.offset), { timeout: 15_000 }).toBeLessThan(40);

    // 2. the browser's back button, from a different row
    const second = await visibleBook(page, 6);
    await page.locator(`[data-app-scroll] a[href='${second.href}']:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`${second.href}$`), { timeout: 60_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/inventory\?page=2&sort=number$/);
    await expect.poll(async () => Math.abs(((await offsetOf(page, second.href)) ?? 99999) - second.offset), { timeout: 15_000 }).toBeLessThan(40);

    // 3. the menu is a NEW entry: nothing old comes back (page 1, the top)
    await page.getByTestId("sidebar-nav").getByRole("link", { name: "מלאי ספרים", exact: true }).click();
    await expect(page).toHaveURL(/\/inventory$/);
    await expect.poll(() => scrollTopOf(page)).toBe(0);
  });

  test("a search and filters are kept; data changing while the person is in the book: the nearest row is used, never the top", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page);
    const stamp = Date.now();
    for (let b = 0; b < 3; b++) await Promise.all(Array.from({ length: 10 }, (_, k) => page.request.post("/api/inventory", { data: { title: `ספר ניווט ${stamp} ${b}${k}`, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } })));
    await page.goto("/inventory?q=" + encodeURIComponent(`ספר ניווט ${stamp}`) + "&sort=title");
    await expect(page.locator("[data-app-scroll] a[href^='/inventory/']:visible")).not.toHaveCount(0);
    await expect.poll(() => page.locator("[data-app-scroll] a[href^='/inventory/']:visible").count()).toBeGreaterThan(12);
    await scroller(page).evaluate((el) => el.scrollTo({ top: 700 }));
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(300);
    const target = await visibleBook(page, 4);
    const id = target.href.split("/").pop()!;

    await page.locator(`[data-app-scroll] a[href='${target.href}']:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`${target.href}$`), { timeout: 60_000 });
    // meanwhile somebody renames the book: the search no longer matches it, the list changes under the person's feet
    const renamed = await page.request.patch(`/api/inventory/${id}`, { data: { title: `אחר לגמרי ${Date.now()}` }, headers: { origin } });
    expect(renamed.ok()).toBeTruthy();
    await scroller(page).getByRole("link", { name: "מלאי", exact: true }).first().click();
    await expect(page).toHaveURL(/q=.*&sort=title|sort=title&q=|q=/);
    expect(page.url()).toContain("sort=title");
    expect(decodeURIComponent(page.url())).toContain("ספר ניווט");
    // the row is gone from the result: the list stays where it was (a neighbour), not at the top
    await expect.poll(() => scrollTopOf(page), { timeout: 15_000 }).toBeGreaterThan(150);
    expect(await offsetOf(page, target.href)).toBeNull();
  });

  test("a catalog's lots table keeps its filter text, and brings the lot's row back", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page);
    const houses = (await (await page.request.get("/api/houses")).json()).houses as { id: string }[];
    const made = await page.request.post("/api/catalogs", { data: { auctionHouseId: houses[0]!.id, number: `N${Date.now().toString().slice(-8)}`, name: "קטלוג ניווט" }, headers: { origin } });
    const catalogId = (await made.json()).catalog.id as string;
    const lots: string[] = [];
    for (let i = 1; i <= 40; i++) {
      const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title: `פריט ניווט ${String(i).padStart(2, "0")}`, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
      lots.push((await r.json()).lot.id);
    }
    await page.goto(`/catalogs/${catalogId}`);
    await page.getByLabel("סינון פריטים").fill("ניווט");
    await expect.poll(() => page.locator("[data-app-scroll] a[href^='/lots/']:visible").count()).toBeGreaterThan(12);
    await scroller(page).evaluate((el) => el.scrollTo({ top: 900 }));
    await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(300);
    const hrefs = await page.evaluate(() => {
      const area = document.querySelector("[data-app-scroll]")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLAnchorElement>("[data-app-scroll] a[href^='/lots/']")]
        .filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.top > area.top + 80 && r.bottom < area.bottom - 20; })
        .map((a) => ({ href: a.getAttribute("href")!, offset: Math.round(a.getBoundingClientRect().top - area.top) }));
    });
    const target = hrefs[Math.min(3, hrefs.length - 1)]!;
    await page.locator(`[data-app-scroll] a[href='${target.href}']:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`${target.href}$`), { timeout: 60_000 });
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/catalogs/${catalogId}`));
    await expect(page.getByLabel("סינון פריטים")).toHaveValue("ניווט");
    await expect.poll(async () => Math.abs(((await offsetOf(page, target.href)) ?? 99999) - target.offset), { timeout: 15_000 }).toBeLessThan(40);

    // a new entry through the menu forgets the old filter text
    // the menu is a new entry: the old filter text is forgotten (here it is the same screen opened again from a full load)
    await page.getByTestId("sidebar-nav").getByRole("button", { name: "מלאי וקליטה" }).click().catch(() => undefined);
    await page.getByTestId("sidebar-nav").getByRole("link", { name: "מלאי ספרים", exact: true }).click();
    await expect(page).toHaveURL(/inventory$/, { timeout: 60_000 });
    await page.goto(`/catalogs/${catalogId}`);
    await expect(page.getByLabel("סינון פריטים")).toHaveValue("");
  });
});

test("a phone: the window is what scrolls - the same row comes back after opening a book and going back", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: "he-IL", baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
  const page = await ctx.newPage();
  await login(page);
  await page.goto("/inventory?page=2&sort=number");
  await expect.poll(() => page.locator("a[href^='/inventory/']:visible").count()).toBeGreaterThan(10);
  await page.evaluate(() => window.scrollTo({ top: 1500 }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  const target = await page.evaluate(() => {
    const a = [...document.querySelectorAll<HTMLAnchorElement>("a[href^='/inventory/']")].filter((x) => x.getClientRects().length > 0 && /[0-9a-f-]{36}$/.test(x.getAttribute("href")!) && x.getBoundingClientRect().top > 120 && x.getBoundingClientRect().bottom < 700)[2]!;
    return { href: a.getAttribute("href")!, top: Math.round(a.getBoundingClientRect().top) };
  });
  await page.locator(`a[href='${target.href}']:visible`).first().click();
  await expect(page).toHaveURL(new RegExp(`${target.href}$`), { timeout: 60_000 });
  await page.goBack();
  await expect(page).toHaveURL(/page=2&sort=number$/);
  await expect
    .poll(async () => page.evaluate((h) => { const a = [...document.querySelectorAll<HTMLAnchorElement>(`a[href='${h}']`)].find((x) => x.getClientRects().length > 0); return a ? Math.round(a.getBoundingClientRect().top) : 99999; }, target.href), { timeout: 15_000 })
    .toBeGreaterThan(target.top - 40);
  expect(await page.evaluate((h) => { const a = [...document.querySelectorAll<HTMLAnchorElement>(`a[href='${h}']`)].find((x) => x.getClientRects().length > 0)!; return Math.round(a.getBoundingClientRect().top); }, target.href)).toBeLessThan(target.top + 40);
  await ctx.close();
});
