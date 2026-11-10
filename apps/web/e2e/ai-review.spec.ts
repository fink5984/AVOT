import { expect, test } from "@playwright/test";
import { ADMIN, apiConsignor, login } from "./helpers";

/*
 * AI button + "תוכן לפרסום בקטלוג" end to end. It calls the REAL active provider (a few cents), so it only runs with
 * E2E_AI_LIVE=1 and against a local database:
 *   $env:E2E_AI_LIVE="1"; $env:E2E_PORT="3001"; npx playwright test e2e/ai-review.spec.ts
 */
test.skip(!process.env.E2E_AI_LIVE, "calls the real AI provider: set E2E_AI_LIVE=1");

test("AI analysis from the book page, review with autosave, approval, filter and re-analysis approval", async ({ page }) => {
  await login(page);
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  const title = `ספר לבדיקת AI ${Date.now()}`;
  const created = await page.request
    .post("/api/inventory", { data: { title, consignorId: consignor.id, author: "מחבר זמני", opId: crypto.randomUUID() }, headers: { origin } })
    .then((r) => r.json());
  const id = created.item.id as string;
  await page.request.put(`/api/inventory/${id}/photographer-notes`, { data: { text: "ספר מוסר. השער לא צולם עדיין.", rev: Date.now() }, headers: { origin } });

  await page.goto(`/inventory/${id}`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: /תוכן לפרסום בקטלוג/ }) });
  await expect(panel.getByText("טרם טופל", { exact: true })).toBeVisible();

  // not analysed yet: blue button, one click starts it, the spinner shows while it runs
  const ai = page.locator("[data-ai-status]");
  await expect(ai).toHaveAttribute("data-ai-status", "NOT_RUN");
  await ai.click();
  await expect(page.getByText(/ניתוח AI התחיל/)).toBeVisible();
  await expect(ai).toHaveAttribute("data-ai-status", /QUEUED|RUNNING/);
  await expect(ai).toHaveAttribute("data-ai-status", "COMPLETED", { timeout: 240_000 });
  await expect(page.getByText(/ניתוח AI הושלם/)).toBeVisible();
  await expect(panel.getByText("ממתין לבדיקה", { exact: true })).toBeVisible();

  // survives a refresh: the state is the database's
  await page.reload();
  await expect(page.locator("[data-ai-status]")).toHaveAttribute("data-ai-status", "COMPLETED");

  // review: start, edit with autosave, leave and come back, approve
  await panel.getByRole("button", { name: "התחל בדיקה" }).click();
  await expect(panel.getByText("בבדיקה", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "פרטי הספר המלאים" }).click();
  const details = page.getByRole("dialog");
  await details.getByLabel("מהדורה").fill("מהדורה שנבדקה ידנית");
  await expect(details.getByText("נשמר", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "סגירה" }).last().click();
  await page.goto("/inventory");
  await page.goto(`/inventory/${id}`);
  await page.getByRole("button", { name: "פרטי הספר המלאים" }).click();
  await expect(page.getByRole("dialog").getByLabel("מהדורה")).toHaveValue("מהדורה שנבדקה ידנית");
  await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).last().click();

  // the inventory table: column + "דורשים בדיקה אנושית"
  await page.goto(`/inventory?view=needs_review&q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: /ספר לבדיקת AI/ }).first()).toBeVisible();
  await page.goto(`/inventory/${id}`);

  await page.getByRole("button", { name: "סיום בדיקה ואישור" }).click();
  await expect(page.getByText("פרטי הפריט אושרו")).toBeVisible();
  await expect(page.locator("section", { has: page.getByRole("heading", { name: /תוכן לפרסום בקטלוג/ }) }).getByText("נבדק ואושר", { exact: true })).toBeVisible();
  await page.goto(`/inventory?view=needs_review&q=${encodeURIComponent(title)}`);
  await expect(page.getByText("אין ספרים בתצוגה זו")).toBeVisible();
  await page.goto(`/inventory?review=APPROVED&q=${encodeURIComponent(title)}`);
  await expect(page.getByRole("link", { name: /ספר לבדיקת AI/ }).first()).toBeVisible();

  // re-analysis: the dialog asks for a manager; a wrong password is refused by the server and nothing starts
  await page.goto(`/inventory/${id}`);
  await page.locator("[data-ai-status]").click();
  const dlg = page.getByRole("dialog", { name: "ניתוח AI חוזר" });
  await expect(dlg.getByText(/הניתוח החדש יחליף/)).toBeVisible();
  await dlg.getByLabel("אימייל המנהל").fill(ADMIN.email);
  await dlg.getByLabel("סיסמת המנהל").fill("definitely-wrong-password");
  await dlg.getByRole("button", { name: "אישור והתחלת ניתוח" }).click();
  await expect(dlg.getByText(/אימות המנהל נכשל/)).toBeVisible();
  await dlg.getByRole("button", { name: "ביטול" }).click();
  await expect(page.locator("[data-ai-status]")).toHaveAttribute("data-ai-status", "COMPLETED");
  // no session can skip the manager approval through the API
  const direct = await page.request.post(`/api/inventory/${id}/ai`, { data: { requestKey: crypto.randomUUID() }, headers: { origin } });
  expect(direct.status()).toBe(403);
});
