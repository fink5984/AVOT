import { expect, type Locator, type Page } from "@playwright/test";

export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@avot.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "Avot-Dev-2026!",
};

export async function login(page: Page, creds = ADMIN) {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill(creds.email);
  await page.getByLabel("סיסמה").fill(creds.password);
  await page.getByRole("button", { name: "כניסה" }).click();
  // the global search is visible at every width (the side navigation is a drawer on phones)
  await expect(page.getByRole("searchbox", { name: "חיפוש גלובלי" })).toBeVisible();
}

/** Capture preferences persist per user — tests start from the defaults. */
export async function resetCapturePrefs(page: Page) {
  const origin = new URL(page.url()).origin;
  await page.request.put("/api/preferences/capture", {
    data: { value: { filmstripScope: "category", continuous: false, lastCamera: null, agentUrl: "http://127.0.0.1:47800", sound: true, captureKey: null } },
    headers: { origin },
  });
  await page.evaluate(() => localStorage.removeItem("avot.capturePrefs"));
}

export const uniqueNumber = () => `E${Date.now().toString().slice(-7)}`;

/** Creates a catalog through the UI and lands on its lots page. */
export async function createCatalog(page: Page, name: string) {
  const number = uniqueNumber();
  await page.goto("/catalogs");
  await page.getByRole("button", { name: "קטלוג חדש" }).click();
  const dialog = page.getByRole("dialog", { name: "קטלוג חדש" });
  await dialog.getByLabel("מספר").fill(number);
  await dialog.getByLabel("שם הקטלוג").fill(name);
  await page.getByRole("button", { name: "יצירת קטלוג" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return { number, catalogId: page.url().split("/catalogs/")[1]!.split(/[?#]/)[0]! };
}

export const E2E_CONSIGNOR = "מפקיד E2E";

/** A consignor for tests that create books through the API (every new book needs one). Reused by name. */
export async function apiConsignor(page: Page, name = E2E_CONSIGNOR): Promise<{ id: string; name: string }> {
  const origin = new URL(page.url()).origin;
  const found = await page.request.get(`/api/consignors?q=${encodeURIComponent(name)}`).then((r) => r.json());
  const hit = (found.consignors as { id: string; name: string }[]).find((c) => c.name === name);
  if (hit) return hit;
  const made = await page.request.post("/api/consignors", { data: { name }, headers: { origin } }).then((r) => r.json());
  return made.consignor;
}

/** Chooses a consignor in the picker inside a dialog (type to search, click the row). */
export async function pickConsignor(dialog: Locator, name = E2E_CONSIGNOR) {
  const combo = dialog.getByRole("combobox");
  if ((await combo.inputValue()) === name) return; // the last consignor is already offered
  await combo.click();
  await combo.fill(name);
  await dialog.getByRole("option", { name: new RegExp(`^${name}`) }).first().click();
  await expect(combo).toHaveValue(name);
}

export async function quickAddLot(page: Page, title: string) {
  await apiConsignor(page);
  await page.getByLabel("הוספה מהירה של פריט").fill(title);
  await page.getByRole("button", { name: "הוספה", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ספר חדש" });
  await pickConsignor(dialog);
  await dialog.getByRole("button", { name: "הוספה לקטלוג" }).click();
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
}

export const strip = (page: Page) => page.getByTestId("strip-item");

/** Opens the camera picker (if needed) and selects a camera whose button text matches. */
export async function pickCamera(page: Page, match: RegExp) {
  const dialog = page.getByRole("dialog", { name: "בחירת מצלמה" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "החלפת מצלמה" }).first().click();
  await dialog.getByRole("button", { name: match }).first().click();
  await expect(page.getByRole("button", { name: "צילום (רווח)" })).toBeEnabled({ timeout: 30_000 });
}

/** Presses the shutter via the Space key and waits until the stack of shots grows. */
export async function shoot(page: Page, times: number, how: "space" | "button" = "space") {
  for (let i = 0; i < times; i++) {
    const before = await strip(page).count();
    if (how === "space") await page.keyboard.press("Space");
    else await page.getByRole("button", { name: "צילום (רווח)" }).click();
    // a shot only counts once it reached durable local storage (or beyond)
    await expect(strip(page)).toHaveCount(before + 1);
    await expect(strip(page).last()).not.toHaveAttribute("data-stage", "CAPTURING");
    await page.waitForTimeout(350); // > double-press guard (300ms)
  }
}
