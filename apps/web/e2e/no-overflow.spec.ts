import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/* No page may grow wider than the window (a long unbroken line, e.g. the inventory numbers of a combined lot, used to push the whole page out). */
for (const width of [1440, 1100, 820, 390]) {
  test(`no sideways overflow at ${width}px: catalog tables, inventory, sold`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const res = await page.request.get("/api/catalogs");
    const catalogs = ((await res.json()) as { catalogs?: { id: string }[] }).catalogs ?? [];
    const urls = ["/inventory", "/sold", "/warehouse", ...catalogs.slice(0, 6).map((c) => `/catalogs/${c.id}`)];
    for (const url of urls) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.documentElement.clientWidth, main: (document.querySelector("main")?.scrollWidth ?? 0) - (document.querySelector("main")?.clientWidth ?? 0) }));
      expect(over.doc, `${url} @${width}`).toBeLessThanOrEqual(0);
      expect(over.body, `${url} body @${width}`).toBeLessThanOrEqual(0);
      // the content area itself must fit too (the page-level guard clips, it must not be what saves us)
      expect(over.main, `${url} content @${width}`).toBeLessThanOrEqual(0);
    }
  });
}
