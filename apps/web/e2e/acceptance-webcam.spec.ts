import { expect, test } from "@playwright/test";
import JSZipLike from "./zip-reader";
import { createCatalog, login, pickCamera, quickAddLot, resetCapturePrefs, shoot, strip } from "./helpers";

/**
 * Main acceptance scenario (spec §20 + webcam addendum §6), executed with
 * Chromium's fake camera through the real Webcam driver → IndexedDB outbox →
 * verified upload → gallery → ZIP. Hardware acceptance with a phone / Canon
 * EOS R7 is a separate manual checklist (docs/hardware-acceptance.md).
 */
test("acceptance: catalog → book → capture per category → organise → complete → other computer → ZIP", async ({ page, browser }) => {
  await login(page);
  await resetCapturePrefs(page);
  const { catalogId } = await createCatalog(page, "קטלוג קבלה אוטומטי");
  await quickAddLot(page, "נועם אלימלך");
  await quickAddLot(page, "שולחן ערוך");
  await expect(page.getByRole("row", { name: /נועם אלימלך/ }).getByText("1", { exact: true })).toBeVisible(); // auto number 1

  // open the capture screen for lot 1
  await page.getByRole("row", { name: /נועם אלימלך/ }).getByRole("link", { name: /צילום פריט 1/ }).click();
  await expect(page).toHaveURL(/\/capture\//);
  await pickCamera(page, /fake_device/i);
  await expect(page.locator("video")).toBeVisible(); // live view

  // שער — 2 shots with the on-screen button
  await page.getByRole("radio", { name: /שער/ }).click();
  await shoot(page, 2, "button");
  // תמונות פנימיות — 5 shots with Space
  await page.getByRole("radio", { name: /תמונות פנימיות/ }).click();
  await shoot(page, 5, "space");
  // כריכה — 3 shots, switching category with the "1" shortcut
  await page.keyboard.press("Digit1");
  await expect(page.getByRole("radio", { name: /כריכה/ })).toHaveAttribute("aria-checked", "true");
  await shoot(page, 3, "space");

  // everything verified on the server, and each shot in the right category
  await page.getByRole("checkbox", { name: "רצועה: כל הקטגוריות" }).check();
  await expect(strip(page)).toHaveCount(10);
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(10, { timeout: 60_000 });
  await expect(page.locator('[data-testid=strip-item][data-category="TITLE_PAGE"]')).toHaveCount(2);
  await expect(page.locator('[data-testid=strip-item][data-category="INTERIOR"]')).toHaveCount(5);
  await expect(page.locator('[data-testid=strip-item][data-category="COVER"]')).toHaveCount(3);

  // the gallery on the book page: reload persists, organise, delete one, restore flow
  const lotUrl = page.url().replace(/\/capture\/([^?]+).*/, "/lots/$1");
  const lotId = lotUrl.split("/lots/")[1]!;
  await page.goto(`${lotUrl}?category=INTERIOR`);
  await page.reload();
  const tiles = page.locator("main ul > li");
  await expect(tiles).toHaveCount(5);

  // reorder by keyboard drag handle: move first photo one step
  const before = await page.request.get(`/api/lots/${lotId}/assets?category=INTERIOR`).then((r) => r.json());
  await tiles.first().hover();
  await tiles.first().getByLabel("גרירה לשינוי סדר").focus();
  // dnd-kit's keyboard sensor activates on the next frame — press like a person, not a macro
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(250);
  await page.keyboard.press("Space");
  await expect
    .poll(async () => (await page.request.get(`/api/lots/${lotId}/assets?category=INTERIOR`).then((r) => r.json())).assets[0].id)
    .not.toBe(before.assets[0].id);

  // delete one interior photo to the recycle bin
  await tiles.nth(4).getByRole("checkbox").click();
  await page.getByRole("button", { name: "לסל המחזור" }).click();
  await expect(tiles).toHaveCount(4);

  // replacement shot + primary photo from the capture screen
  await page.goto(`/capture/${lotId}?category=INTERIOR`);
  await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeEnabled({ timeout: 30_000 });
  // the "all categories" filmstrip preference chosen earlier was persisted for this user
  await expect(page.getByRole("checkbox", { name: "רצועה: כל הקטגוריות" })).toBeChecked();
  const interior = page.locator('[data-testid=strip-item][data-category="INTERIOR"]');
  await expect(interior).toHaveCount(4);
  await shoot(page, 1, "space");
  await expect(page.locator('[data-testid=strip-item][data-category="INTERIOR"][data-stage="VERIFIED"]')).toHaveCount(5, { timeout: 30_000 });
  await interior.first().hover();
  await interior.first().getByRole("button", { name: "הגדרה כתמונה ראשית" }).click();
  await expect(interior.first().getByTitle("תמונה ראשית")).toBeVisible();

  // mark complete and continue to the next lot (continuous mode) without reconnecting the camera
  await page.getByRole("checkbox", { name: "צילום רציף לפי פריטים" }).check();
  await page.getByRole("button", { name: "סיום פריט" }).click();
  await page.getByRole("button", { name: "סיום ומעבר לפריט הבא" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(lotId)); // the URL now points at lot 2
  await expect(page.locator("header").getByText(/שולחן ערוך/)).toBeVisible();
  await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeEnabled(); // still connected

  const lot = await page.request.get(`/api/lots/${lotId}`).then((r) => r.json());
  expect(lot.lot.status).toBe("COMPLETED");
  expect(lot.lot.photoCount).toBe(10); // 2 + 5 − 1 + 1 + 3
  expect(lot.lot.primaryAssetId).toBeTruthy();

  // "another computer": a fresh browser context sees the synced photos
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const p2 = await other.newPage();
  await login(p2);
  await p2.goto(`/lots/${lotId}`);
  await expect(p2.getByRole("heading", { name: "נועם אלימלך" })).toBeVisible();
  await expect(p2.locator("main ul > li")).toHaveCount(10);

  // ZIP of the whole book
  await p2.getByRole("button", { name: "הורדת הספר (ZIP)" }).click();
  await p2.getByRole("button", { name: "יצירת קובץ ZIP" }).click();
  const download = p2.waitForEvent("download");
  await p2.getByRole("link", { name: "הורדה" }).click({ timeout: 60_000 });
  const file = await download;
  const zip = await JSZipLike.fromFile(await file.path());
  const names = zip.names();
  expect(names.filter((n) => /\/Lot-001\/cover\/L001-cover-\d{3}\.jpg$/.test(n))).toHaveLength(3);
  expect(names.filter((n) => /\/Lot-001\/title-page\//.test(n) && n.endsWith(".jpg"))).toHaveLength(2);
  expect(names.filter((n) => /\/Lot-001\/interior\//.test(n) && n.endsWith(".jpg"))).toHaveLength(5);
  expect(names.some((n) => n.endsWith("manifest.csv"))).toBeTruthy();
  await other.close();

  // the catalog CSV export lists the book with per-category counts
  const csv = await page.request.get(`/api/catalogs/${catalogId}/lots-csv`).then((r) => r.text());
  expect(csv).toContain("נועם אלימלך");
});
