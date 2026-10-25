import { expect, test, type Page } from "@playwright/test";
import { createCatalog, login, pickCamera, quickAddLot, resetCapturePrefs, shoot, strip } from "./helpers";

async function openCapture(page: Page, title: string) {
  await login(page);
  await resetCapturePrefs(page);
  await createCatalog(page, `בדיקות צילום ${Date.now()}`);
  await quickAddLot(page, title);
  await page.getByRole("row", { name: new RegExp(title) }).getByRole("link", { name: /צילום פריט/ }).click();
  await expect(page).toHaveURL(/\/capture\//);
  const lotId = page.url().split("/capture/")[1]!.split("?")[0]!;
  return lotId;
}

async function serverAssets(page: Page, lotId: string) {
  return (await page.request.get(`/api/lots/${lotId}/assets`).then((r) => r.json())).assets as { category: string; uploadStatus: string; captureId: string }[];
}

test("shot keeps the category active at shutter time even if the user switches during a slow capture", async ({ page }) => {
  const lotId = await openCapture(page, "בדיקת הקפאת קטגוריה");
  await pickCamera(page, /סימולטור מצלמה \(דפדפן\)/);
  await page.getByRole("combobox", { name: "השהיית צילום" }).selectOption("1200"); // slow shutter-to-file
  await page.getByRole("radio", { name: /שער/ }).click();
  await page.keyboard.press("Space");
  await page.getByRole("radio", { name: /תמונות פנימיות/ }).click(); // switch while the file is still "in the camera"
  await page.getByRole("checkbox", { name: "רצועה: כל הקטגוריות" }).check();
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(1, { timeout: 30_000 });
  const assets = await serverAssets(page, lotId);
  expect(assets).toHaveLength(1);
  expect(assets[0]!.category).toBe("TITLE_PAGE");
});

test("rapid double press creates exactly one shot; failures never show as saved; disconnect + reconnect", async ({ page }) => {
  const lotId = await openCapture(page, "בדיקת לחיצה כפולה");
  await pickCamera(page, /סימולטור מצלמה \(דפדפן\)/);

  // double press within 100ms
  await page.keyboard.press("Space");
  await page.waitForTimeout(80);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(800);
  expect(await strip(page).count()).toBe(1);

  // injected capture failure → FAILED, nothing stored on the server
  await page.getByRole("checkbox", { name: "כשל בצילום הבא" }).check();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-testid=strip-item][data-stage="FAILED"]')).toHaveCount(1);
  await expect(page.getByText("הצילום נכשל — התמונה לא נשמרה")).toBeVisible();
  expect(await serverAssets(page, lotId)).toHaveLength(1);

  // simulated disconnect blocks capture with a clear message, reconnect restores it
  await page.getByRole("button", { name: "הדמיית ניתוק" }).click();
  await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeDisabled();
  await expect(page.getByText(/הסימולטור נותק/).first()).toBeVisible();
  await page.getByRole("button", { name: "חיבור מחדש" }).first().click();
  await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeEnabled();
  await page.waitForTimeout(350);
  await shoot(page, 1);
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(2, { timeout: 30_000 });
});

test("offline: capture keeps working locally, survives closing the tab, and syncs when back online", async ({ page, context }) => {
  const lotId = await openCapture(page, "בדיקת עבודה ללא אינטרנט");
  await pickCamera(page, /סימולטור מצלמה \(דפדפן\)/);

  await context.setOffline(true);
  await shoot(page, 3);
  // stored locally, not claimed as cloud-verified
  await expect(page.locator('[data-testid=strip-item][data-stage="VERIFIED"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=strip-item][data-stage="SAVED_LOCAL"], [data-testid=strip-item][data-stage="QUEUED"], [data-testid=strip-item][data-stage="UPLOADING"]')).toHaveCount(3);
  await expect(page.getByText(/ממתינות להעלאה/).first()).toBeVisible();

  // the tab goes away before anything was uploaded
  page.removeAllListeners("dialog");
  await page.close({ runBeforeUnload: false });
  await context.setOffline(false);
  expect(await serverAssets(await context.newPage(), lotId).catch(() => [])).toHaveLength(0);

  // any page of the app resumes the durable queue
  const again = await context.newPage();
  await again.goto("/");
  await expect.poll(async () => (await serverAssets(again, lotId)).filter((a) => a.uploadStatus === "VERIFIED").length, { timeout: 60_000 }).toBe(3);
});
