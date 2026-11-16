import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, login, markPhotoComplete } from "./helpers";

/*
 * The editor's workspace on the catalog's lot page, "הערות לבדיקה", and the photography gate of the AI - through the real
 * UI and API, two browsers where two people matter. The AI itself runs against the scripted fake server:
 *   node test/e2e-fake-openai.mjs   +   the app started with BOOK_AI_OPENAI_BASE_URL=http://127.0.0.1:3299/v1 OPENAI_API_KEY=fake
 *   E2E_FAKE_AI=1 E2E_BASE_URL=http://localhost:3200 npx playwright test e2e/editor-workspace.spec.ts
 */

async function lotWithBook(page: Page, title: string) {
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  // a catalog through the API (the catalog list UI is covered by its own specs)
  const houses = (await (await page.request.get("/api/houses")).json()).houses as { id: string }[];
  const made = await page.request.post("/api/catalogs", { data: { auctionHouseId: houses[0]!.id, number: `W${Date.now().toString().slice(-8)}`, name: `קטלוג ${title}` }, headers: { origin } });
  expect(made.ok()).toBeTruthy();
  const catalogId = (await made.json()).catalog.id as string;
  const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
  expect(r.ok()).toBeTruthy();
  const lot = (await r.json()).lot as { id: string; lotNumber: number; inventoryItemId: string };
  return { catalogId, lotId: lot.id, itemId: lot.inventoryItemId, origin };
}

test.describe("review notes: one list for the inventory and the catalog", () => {
  test("add from the inventory → visible in the lot; add from the lot → visible in the inventory; handle with a conclusion; badges and filters", async ({ page, browser }) => {
    await login(page);
    const { catalogId, lotId, itemId } = await lotWithBook(page, `ספר הערות ${Date.now()}`);

    // inventory: an empty, small panel with the invitation to add
    await page.goto(`/inventory/${itemId}`);
    const panel = page.getByTestId("review-notes");
    await expect(panel).toContainText("אין הערות פתוחות");
    await expect(panel).toContainText("לא נשלח ל-AI");
    await panel.getByLabel("הערה חדשה לבדיקה").fill("לבדוק אם החתימה היא של רבי משה");
    await panel.getByRole("button", { name: "הוספת הערה" }).click();
    await expect(panel).toContainText("1 פתוחות");
    await expect(panel.getByTestId("review-note")).toContainText("לבדוק אם החתימה היא של רבי משה");

    // the lot page shows exactly that note, open and prominent
    await page.goto(`/lots/${lotId}`);
    const lotPanel = page.getByTestId("review-notes");
    await expect(lotPanel).toHaveAttribute("data-open-notes", "1");
    await expect(lotPanel).toContainText("לבדוק אם החתימה היא של רבי משה");
    // add from the catalog
    await lotPanel.getByLabel("הערה חדשה לבדיקה").fill("ייתכן שחסרים שני דפים בסוף");
    await lotPanel.getByRole("button", { name: "הוספת הערה" }).click();
    await expect(lotPanel).toHaveAttribute("data-open-notes", "2");

    // the catalog table: compact badge + filter
    await page.goto(`/catalogs/${catalogId}`);
    await expect(page.getByTestId("open-notes-badge").first()).toContainText("2 הערות לבדיקה");
    await page.getByLabel("סינון לפי הערות לבדיקה").selectOption("none");
    await expect(page.getByTestId("open-notes-badge")).toHaveCount(0);
    await page.getByLabel("סינון לפי הערות לבדיקה").selectOption("open");
    await expect(page.getByTestId("open-notes-badge").filter({ visible: true }).first()).toBeVisible();

    // the inventory list: badge + filter
    await page.goto("/inventory?notes=open");
    await expect(page.getByTestId("open-notes-badge").filter({ visible: true }).first()).toContainText("2 הערות לבדיקה");

    // handle one note from the inventory page: verified with a conclusion
    await page.goto(`/inventory/${itemId}`);
    const note = page.getByTestId("review-note").filter({ hasText: "חסרים שני דפים" });
    await note.getByRole("button", { name: "נבדק ולא אומת" }).click();
    await note.getByLabel("מסקנת הבדיקה").fill("הספר שלם, נבדק מול הדגימה");
    await note.getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByTestId("review-notes")).toHaveAttribute("data-open-notes", "1");

    // the lot page: status, conclusion, who and when - and nothing was deleted
    await page.goto(`/lots/${lotId}`);
    const handled = page.getByTestId("review-notes").locator("details");
    await expect(handled).toContainText("נבדק ולא אומת");
    await expect(handled).toContainText("הספר שלם, נבדק מול הדגימה");
    await expect(handled).toContainText("נבדקה על ידי");

    // a second browser (another person) sees a note appear without reloading: the shared poll refreshes the page
    const ctx2 = await browser.newContext({ locale: "he-IL", baseURL: new URL(page.url()).origin });
    const page2 = await ctx2.newPage();
    await login(page2);
    await page2.goto(`/inventory/${itemId}`);
    await expect(page2.getByTestId("review-notes")).toHaveAttribute("data-open-notes", "1");
    await page.getByTestId("review-notes").getByLabel("הערה חדשה לבדיקה").fill("להשוות את ההקדשה לכתב יד מאומת");
    await page.getByTestId("review-notes").getByRole("button", { name: "הוספת הערה" }).click();
    await expect(page2.getByTestId("review-notes")).toHaveAttribute("data-open-notes", "2", { timeout: 25_000 });
    await ctx2.close();
  });

  test("the approval tells the approver about open notes (and still lets them decide)", async ({ page }) => {
    await login(page);
    const { itemId, origin } = await lotWithBook(page, `ספר אישור ${Date.now()}`);
    await page.request.post(`/api/inventory/${itemId}/review-notes`, { data: { text: "לברר אם יש מקור למידע בתיאור" }, headers: { origin } });
    await page.goto(`/inventory/${itemId}`);
    await expect(page.getByTestId("approve-open-notes")).toContainText("הערות לבדיקה פתוחות");
    page.once("dialog", (d) => {
      expect(d.message()).toContain("הבירורים לא הושלמו");
      void d.dismiss();
    });
    await page.getByRole("button", { name: "סיום בדיקה ואישור" }).click();
    await expect(page.getByTestId("review-notes")).toHaveAttribute("data-open-notes", "1");
  });

  test("the photographer's notes are a secondary, collapsible area; the review notes stay in view", async ({ page }) => {
    await login(page);
    const { itemId } = await lotWithBook(page, `ספר מצלם ${Date.now()}`);
    await page.goto(`/inventory/${itemId}`);
    const secondary = page.getByTestId("photographer-notes-secondary");
    await expect(secondary).toBeVisible();
    await expect(secondary).not.toHaveAttribute("open", "");
    await secondary.getByText("הערות המצלם").first().click();
    await expect(secondary.getByLabel("הערות המצלם")).toBeVisible();
    await expect(page.getByTestId("review-notes")).toBeVisible();
  });

  test("a phone: the notes are high on the page, readable, and can be added and closed", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: "he-IL", baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const page = await ctx.newPage();
    await login(page);
    const { itemId, origin } = await lotWithBook(page, `ספר נייד ${Date.now()}`);
    await page.request.post(`/api/inventory/${itemId}/review-notes`, { data: { text: "הערה בנייד" }, headers: { origin } });
    await page.goto(`/inventory/${itemId}`);
    const panel = page.getByTestId("review-notes");
    await expect(panel).toBeVisible();
    // before the long edit panel, within the first screens
    const top = await panel.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(top).toBeLessThan(2400);
    await panel.getByLabel("הערה חדשה לבדיקה").fill("עוד הערה מהנייד");
    await panel.getByRole("button", { name: "הוספת הערה" }).click();
    await expect(panel).toHaveAttribute("data-open-notes", "2");
    const note = panel.getByTestId("review-note").filter({ hasText: "הערה בנייד" });
    await note.getByRole("button", { name: "נבדק ואומת" }).click();
    await note.getByRole("button", { name: "שמירה" }).click();
    await expect(panel).toHaveAttribute("data-open-notes", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await ctx.close();
  });
});

test.describe("the catalog lot page is the full editing environment", () => {
  test("headline + description under the photos, edited in place with bold, the same book from the inventory; dedicated text is kept", async ({ page }) => {
    await login(page);
    const { lotId, itemId, origin } = await lotWithBook(page, `ספר סנכרון ${Date.now()}`);

    await page.goto(`/lots/${lotId}`);
    // the live sections of the book page are here: the catalog content, the AI addition, the review state and the sources area
    await expect(page.getByLabel("כותרת קטלוגית")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" })).toBeVisible();
    await expect(page.getByRole("button", { name: "הוספת המידע ב-AI" })).toBeVisible();
    await expect(page.getByTestId("review-summary")).toBeVisible();

    // edit from the catalog (autosave) → the inventory shows it
    await page.getByLabel("כותרת קטלוגית").fill("כותרת מהקטלוג");
    const editor = page.getByRole("textbox", { name: "תיאור קטלוגי" });
    await editor.click();
    await page.keyboard.type("תיאור שנכתב בקטלוג");
    await expect(page.getByText("נשמר", { exact: true }).first()).toBeVisible();
    await page.goto(`/inventory/${itemId}`);
    await expect(page.getByLabel("כותרת קטלוגית")).toHaveValue("כותרת מהקטלוג");
    await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" })).toContainText("תיאור שנכתב בקטלוג");

    // and the other way: an edit in the inventory reaches the lot (the lot still held the book's text)
    await page.getByLabel("כותרת קטלוגית").fill("כותרת מהמלאי");
    await expect(page.getByText("נשמר", { exact: true }).first()).toBeVisible();
    await page.goto(`/lots/${lotId}`);
    await expect(page.getByLabel("כותרת קטלוגית")).toHaveValue("כותרת מהמלאי");
    const lotJson = await page.request.get(`/api/lots/${lotId}`).then((r) => r.json());
    expect(lotJson.lot.shortDescription).toBe("כותרת מהמלאי");

    // (a lot text written on purpose is never overwritten by the book: covered by the integration tests; the single-lot page shows no second title)
    await expect(page.getByTestId("catalog-draft-diverged")).toHaveCount(0);
  });
});

test.describe("AI waits for the end of photography", () => {
  test("the button is visible but disabled with the reason, in the inventory and in the catalog; the API refuses; it opens when photography is complete", async ({ page }) => {
    await login(page);
    const { catalogId, lotId, itemId, origin } = await lotWithBook(page, `ספר צילום ${Date.now()}`);

    for (const url of [`/inventory/${itemId}`, `/lots/${lotId}`]) {
      await page.goto(url);
      const ai = page.locator("[data-ai-status]").first();
      await expect(ai).toBeDisabled();
      await expect(ai).toHaveAttribute("data-photo-blocked", "true");
      await expect(ai).toHaveAttribute("title", /לא ניתן לבצע ניתוח AI לפני השלמת צילום הספר/);
    }
    // the table row: disabled with the reason in the tooltip (no extra text in a dense list)
    await page.goto(`/catalogs/${catalogId}`);
    await expect(page.locator("[data-photo-blocked]").first()).toBeDisabled();
    // the inventory list too
    await page.goto(`/inventory?q=${encodeURIComponent("ספר צילום")}`);
    await expect(page.locator("[data-photo-blocked]").first()).toBeDisabled();

    // directly through the API: refused, nothing queued
    const refused = await page.request.post(`/api/inventory/${itemId}/ai`, { data: { requestKey: crypto.randomUUID() }, headers: { origin } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.message).toContain("לא ניתן לבצע ניתוח AI לפני השלמת צילום הספר.");
    const state = await page.request.get(`/api/inventory/${itemId}/ai`).then((r) => r.json());
    expect(state.aiStatus).toBe("NOT_RUN");
    expect(state.runs).toHaveLength(0);

    // photography complete → the page updates by itself (no reload) and the button works
    await page.goto(`/lots/${lotId}`);
    await markPhotoComplete(page, itemId);
    await expect(page.locator("[data-ai-status]").first()).toBeEnabled({ timeout: 25_000 });
  });

  test.describe("with the fake AI", () => {
    test.skip(!process.env.E2E_FAKE_AI, "needs the fake AI server and an app started against it: set E2E_FAKE_AI=1");

    test("started from the catalog page: the inventory shows the same state and the same result", async ({ page, browser }) => {
      await login(page);
      const { lotId, itemId } = await lotWithBook(page, `ספר AI ${Date.now()}`);
      await markPhotoComplete(page, itemId);
      await page.goto(`/lots/${lotId}`);
      const ai = page.locator("[data-ai-status]").first();
      await expect(ai).toHaveAttribute("data-ai-status", "NOT_RUN");

      const ctx2 = await browser.newContext({ locale: "he-IL", baseURL: new URL(page.url()).origin });
      const page2 = await ctx2.newPage();
      await login(page2);
      await page2.goto(`/inventory/${itemId}`);

      await ai.click();
      await expect(ai).toHaveAttribute("data-ai-status", "COMPLETED", { timeout: 120_000 });
      // the other person's inventory page learns the outcome without a reload
      await expect(page2.locator("[data-ai-status]").first()).toHaveAttribute("data-ai-status", "COMPLETED", { timeout: 40_000 });
      // the same text on both pages
      await expect(page.getByLabel("כותרת קטלוגית")).not.toHaveValue("", { timeout: 40_000 });
      const h1 = await page.getByLabel("כותרת קטלוגית").inputValue();
      await expect(page2.getByLabel("כותרת קטלוגית")).toHaveValue(h1, { timeout: 40_000 });
      await ctx2.close();
    });
  });
});

test.describe("a combined lot", () => {
  test("every book keeps its own notes and its own workspace; the shared description stays a separate entity", async ({ page }) => {
    await login(page);
    const origin = new URL(page.url()).origin;
    const consignor = await apiConsignor(page, "מפקיד לוט משולב E2E");
    const houses = (await (await page.request.get("/api/houses")).json()).houses as { id: string }[];
    const made = await page.request.post("/api/catalogs", { data: { auctionHouseId: houses[0]!.id, number: `C${Date.now().toString().slice(-8)}`, name: "קטלוג משולב סביבת עבודה" }, headers: { origin } });
    const catalogId = (await made.json()).catalog.id as string;
    const add = async (title: string) => {
      const r = await page.request.post(`/api/catalogs/${catalogId}/lots`, { data: { title, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } });
      return (await r.json()).lot as { id: string; inventoryItemId: string };
    };
    const a = await add("ספר ראשון בלוט");
    const b = await add("ספר שני בלוט");
    const merged = await page.request.post(`/api/catalogs/${catalogId}/lots/merge`, { data: { lotIds: [a.id, b.id], keepLotId: a.id, title: "שני ספרים משותפים" }, headers: { origin } });
    expect(merged.ok()).toBeTruthy();
    await page.request.post(`/api/inventory/${a.inventoryItemId}/review-notes`, { data: { text: "הערה רק לספר הראשון" }, headers: { origin } });
    await page.request.post(`/api/inventory/${b.inventoryItemId}/review-notes`, { data: { text: "הערה רק לספר השני" }, headers: { origin } });

    await page.goto(`/lots/${a.id}`);
    const panels = page.getByTestId("combined-notes").getByTestId("review-notes");
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toContainText("ספר ראשון בלוט");
    await expect(panels.nth(0)).toContainText("הערה רק לספר הראשון");
    await expect(panels.nth(0)).not.toContainText("הערה רק לספר השני");
    await expect(panels.nth(1)).toContainText("ספר שני בלוט");
    await expect(panels.nth(1)).toContainText("הערה רק לספר השני");

    // the workspace of one book at a time (its own AI state, review and catalog text); the shared description is another panel
    const picker = page.getByTestId("combined-book-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByLabel("כותרת קטלוגית")).toHaveCount(1);
    await picker.getByRole("link", { name: /ספר שני בלוט/ }).click();
    await expect(page).toHaveURL(/book=/, { timeout: 60_000 });
    await page.getByLabel("כותרת קטלוגית").fill("כותרת הספר השני בלבד");
    await expect(page.getByText("נשמר", { exact: true }).first()).toBeVisible();
    const bookB = await page.request.get(`/api/inventory/${b.inventoryItemId}`).then((r) => r.json());
    const bookA = await page.request.get(`/api/inventory/${a.inventoryItemId}`).then((r) => r.json());
    expect(bookB.item.catalogHeadline).toBe("כותרת הספר השני בלבד");
    expect(bookA.item.catalogHeadline ?? null).not.toBe("כותרת הספר השני בלבד");
    // the lot's own shared title is untouched by a book's edit
    await expect(page.getByRole("heading", { level: 1, name: "שני ספרים משותפים" })).toBeVisible();
  });
});
