import { expect, test, type Page } from "@playwright/test";
import { login, pickCamera, resetCapturePrefs, shoot, strip } from "./helpers";

/**
 * Phase 2 through the real UI: inventory → scan-to-capture (Webcam driver with
 * Chromium's fake camera) → labels → handheld (keyboard-wedge typing, offline
 * queue, sync) → assignment to a catalog. The API-level scenario with every
 * edge case is tests/phase2-acceptance.mjs.
 */

const RUN = Date.now().toString(36).slice(-5).toUpperCase();

async function ensureShelf(page: Page) {
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const tree = (await (await page.request.get("/api/warehouse")).json()).warehouses;
  const wh = tree.find((w: { isDefault: boolean }) => w.isDefault) ?? tree[0];
  let zone = wh.zones.find((z: { code: string }) => z.code === "A");
  if (!zone) zone = (await (await page.request.post("/api/warehouse/zones", { data: { code: "A" }, headers })).json()).zone;
  let shelf = (zone.shelves ?? []).find((s: { code: string }) => s.code === "03");
  if (!shelf) shelf = (await (await page.request.post("/api/warehouse/shelves", { data: { zoneId: zone.id, code: "03" }, headers })).json()).shelf;
  for (const cell of ["02", "03"]) {
    const r = await page.request.get(`/api/warehouse/locations?code=LOC-A-03-${cell}`);
    if (r.status() === 404) await page.request.post("/api/warehouse/locations", { data: { shelfId: shelf.id, cells: [cell] }, headers });
  }
}

/** A keyboard-wedge scanner types the code and presses Enter into the focused field. */
async function wedge(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 8 });
  await page.keyboard.press("Enter");
}

test("phase 2 UI: inventory → scan to capture → labels → handheld (incl. offline) → assign", async ({ page, context }) => {
  test.setTimeout(300_000);
  await login(page);
  await resetCapturePrefs(page);
  await ensureShelf(page);

  // 1. receive a book into inventory through the form
  await page.goto("/inventory?new=1");
  const form = page.getByRole("dialog", { name: "ספר חדש למלאי" });
  await expect(form).toBeVisible();
  await form.getByLabel("שם הספר").fill(`ספר UI ${RUN}`);
  await form.getByLabel("מחבר").fill("מחבר UI");
  await page.getByRole("button", { name: "קליטה למלאי" }).click();
  await expect(page).toHaveURL(/\/inventory\/[0-9a-f-]{36}$/);
  const inventoryNumber = (await page.locator("header .font-mono").first().textContent())!.trim();
  expect(inventoryNumber).toMatch(/^ITM-\d{6}$/);
  const itemId = page.url().split("/inventory/")[1]!;

  // 2. book label: Code 128 SVG + antique-binding warning
  await page.goto(`/labels/books?ids=${itemId}`);
  await expect(page.getByText("אין להדביק את התווית על הכריכה")).toBeVisible();
  await expect(page.locator(".label svg rect").first()).toBeAttached();
  await expect(page.locator(".label").getByText(inventoryNumber)).toBeVisible();

  // 3. open the capture studio by scanning the tag, shoot 4 categories with the fake webcam
  await page.goto("/capture");
  await page.getByLabel("סריקת ספר לצילום").fill(inventoryNumber);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/capture/${itemId}`));
  await expect(page.locator("header").getByText(inventoryNumber)).toBeVisible();
  await pickCamera(page, /fake_device/i);
  for (const cat of ["כריכה", "שער", "תמונות פנימיות", "תמונות חוץ"]) {
    await page.getByRole("radio", { name: new RegExp(cat) }).click();
    await shoot(page, 1, "space");
  }
  await page.getByRole("checkbox", { name: "רצועה: כל הקטגוריות" }).check();
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(4, { timeout: 60_000 });
  const assets = (await (await page.request.get(`/api/lots/${itemId}/assets`)).json()).assets;
  expect(assets).toHaveLength(4);
  expect(new Set(assets.map((a: { category: string }) => a.category)).size).toBe(4);

  // 4. handheld: store by shelf scan + book scan, typed as a keyboard wedge
  await page.goto("/scanner");
  const input = page.getByLabel("קלט סורק");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "אחסון", exact: true }).click();
  await wedge(page, "LOC-A-03-02");
  await expect(page.getByTestId("active-location")).toContainText("LOC-A-03-02");
  await wedge(page, inventoryNumber);
  const result = page.getByTestId("scan-result");
  await expect(result).toHaveAttribute("data-kind", "ok");
  await expect(result).toContainText(inventoryNumber);
  await expect(result).toContainText("LOC-A-03-02");
  await expect(page.getByTestId("scan-log").locator("li").first()).toHaveAttribute("data-status", "synced");

  // 5. offline: a shelf change + book scan are queued on the device, never shown as saved
  await context.setOffline(true);
  await page.getByRole("button", { name: "העברה", exact: true }).click();
  await wedge(page, "LOC-A-03-03");
  await expect(page.getByTestId("active-location")).toContainText("LOC-A-03-03"); // known shelf, from the device cache
  await wedge(page, inventoryNumber);
  await expect(result).toHaveAttribute("data-kind", "queued");
  await expect(result).toContainText("ממתין לסנכרון");
  await expect(page.getByTestId("scan-log").locator('li[data-status="pending"]')).toHaveCount(2);
  let item = (await (await page.request.get(`/api/inventory/${itemId}`)).json()).item;
  void item; // page.request bypasses the offline emulation; the server still has the old place:
  expect(item.currentLocation?.code ?? null).toBe("LOC-A-03-02");

  // back online → the queue syncs in scan order and the statuses turn into server answers
  await context.setOffline(false);
  await expect(page.getByTestId("scan-log").locator('li[data-status="pending"]')).toHaveCount(0, { timeout: 30_000 });
  item = (await (await page.request.get(`/api/inventory/${itemId}`)).json()).item;
  expect(item.currentLocation.code).toBe("LOC-A-03-03");

  // 6. command barcode switches the mode; find shows the book
  await wedge(page, "CMD-FIND");
  await expect(page.getByRole("button", { name: "איתור", exact: true })).toHaveAttribute("aria-pressed", "true");
  await wedge(page, inventoryNumber);
  await expect(result).toContainText("LOC-A-03-03");

  // 7. assign to a catalog of טבין from the book page; history shows the movements
  const origin = new URL(page.url()).origin;
  const houses = (await (await page.request.get("/api/houses")).json()).houses;
  const tavin = houses.find((h: { slug: string }) => h.slug === "tavin");
  await page.request.post("/api/catalogs", { data: { number: `UI-${RUN}`, name: `קטלוג UI ${RUN}`, auctionHouseId: tavin.id }, headers: { origin } });
  await page.goto(`/inventory/${itemId}`);
  await page.getByRole("button", { name: "שייך לקטלוג" }).click();
  const dlg = page.getByRole("dialog", { name: /שיוך לקטלוג/ });
  await dlg.getByRole("radio", { name: "טבין" }).click();
  await dlg.getByRole("combobox", { name: "קטלוג" }).selectOption({ label: `UI-${RUN} · קטלוג UI ${RUN}` });
  await dlg.getByLabel("מספר פריט").fill("62");
  await page.getByRole("button", { name: "שיוך", exact: true }).click();
  await expect(page.getByText(/קטלוג\s*UI-/).first()).toBeVisible();
  await expect(page.getByText("פריט 62").first()).toBeVisible();
  await expect(page.getByText(/הועבר: LOC-A-03-02/)).toBeVisible();
  await expect(page.getByText(/אוחסן/)).toBeVisible();

  // the lot shows the book's 4 photos (no copies)
  const lots = (await (await page.request.get(`/api/inventory/${itemId}`)).json()).lots;
  const lot = lots.find((l: { assignmentStatus: string }) => l.assignmentStatus === "ACTIVE");
  const lotAssets = (await (await page.request.get(`/api/lots/${lot.id}/assets?scope=lot`)).json()).assets;
  expect(lotAssets.map((a: { id: string }) => a.id).sort()).toEqual(assets.map((a: { id: string }) => a.id).sort());
});

test("phase 2 screens fit a phone (no horizontal scrolling)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  for (const path of ["/inventory", "/warehouse", "/scanner", "/houses", "/capture", "/scans", "/warehouse/picking"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  void strip;
});
