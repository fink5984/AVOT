import { expect, test } from "@playwright/test";
import { apiConsignor, login } from "./helpers";

/*
 * Research section, automatic bold and the background "הוספת מידע ב-AI" end to end, against the SCRIPTED fake OpenAI
 * server (no paid call):
 *   node test/e2e-fake-openai.mjs
 *   $env:BOOK_AI_OPENAI_BASE_URL="http://127.0.0.1:3299/v1"; $env:OPENAI_API_KEY="fake"   # for the app under test
 *   $env:E2E_FAKE_AI="1"; $env:E2E_BASE_URL="http://localhost:3200"; npx playwright test e2e/ai-background.spec.ts
 */
test.skip(!process.env.E2E_FAKE_AI, "needs the fake AI server and an app started against it: set E2E_FAKE_AI=1");

const BOLD = 'span[style*="font-weight: 700"]';

test("analysis with research: short headline, bold, sources with links; an addition keeps running after leaving the page and a second browser sees it", async ({ page, browser }) => {
  await login(page);
  const origin = new URL(page.url()).origin;
  const consignor = await apiConsignor(page);
  const created = await page.request.post("/api/inventory", { data: { title: `ספר מחקר ${Date.now()}`, consignorId: consignor.id, opId: crypto.randomUUID() }, headers: { origin } }).then((r) => r.json());
  const id = created.item.id as string;

  await page.goto(`/inventory/${id}`);
  const ai = page.locator("[data-ai-status]");
  await expect(ai).toHaveAttribute("data-ai-status", "NOT_RUN");
  await ai.click();
  await expect(ai).toHaveAttribute("data-ai-status", "COMPLETED", { timeout: 120_000 });

  // the research section lives under the description, compact by default
  await page.reload();
  const summary = page.getByTestId("research-summary");
  await expect(summary).toContainText("1 ממצא בתמונות");
  await expect(summary).toContainText("2 מקורות חיצוניים");
  await expect(summary).toContainText("פרטים דורשים בדיקה");
  await expect(page.getByTestId("research-sources")).toHaveCount(0);
  await page.getByTestId("research-toggle").click();
  const sources = page.getByTestId("research-sources");
  await expect(sources).toContainText("הספרייה הלאומית");
  await expect(sources).toContainText("על עותק אחר");
  const link = sources.getByRole("link", { name: /חובות הלבבות - הספרייה הלאומית/ });
  await expect(link).toHaveAttribute("href", "https://www.nli.org.il/he/books/NNL_ALEPH000000001");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(sources).toContainText("נשען עליו בתיאור: החיבור נדפס פעמים רבות");
  // what was identified in the photos is here, no longer inside the pencil window
  await expect(page.getByRole("region", { name: "מה זוהה בתמונות" })).toContainText("שייך לה");
  await page.getByRole("button", { name: /עריכת פרטי הספר|פרטי הספר המלאים/ }).first().click();
  await expect(page.getByRole("dialog")).not.toContainText("מה זוהה בתמונות");
  await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).last().click();

  // short headline, the key feature first; bold shown in the editor and kept after a refresh
  const headline = page.getByLabel("כותרת קטלוגית");
  await expect(headline).toHaveValue("הקדשה בכתב ידו של המחבר - חובות הלבבות");
  const editor = page.getByRole("textbox", { name: "תיאור קטלוגי" });
  await expect(editor.locator(BOLD)).toHaveText("הקדשה בכתב ידו של המחבר");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" }).locator(BOLD)).toHaveText("הקדשה בכתב ידו של המחבר");

  // a manual edit after the AI: typing at the end keeps the AI's bold and is autosaved with it
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" הערה ידנית.");
  await expect(page.getByText("נשמר", { exact: true }).first()).toBeVisible();
  await page.reload();
  const afterManual = page.getByRole("textbox", { name: "תיאור קטלוגי" });
  await expect(afterManual).toContainText("הערה ידנית.");
  await expect(afterManual.locator(BOLD)).toHaveText("הקדשה בכתב ידו של המחבר");

  // a second browser opens the same book
  const other = await browser.newContext({ locale: "he-IL", baseURL: new URL(page.url()).origin });
  const page2 = await other.newPage();
  await login(page2);
  await page2.goto(`/inventory/${id}`);

  // an addition: the job runs on the server (the fake model takes a few seconds)
  await page.getByLabel("הוספת מידע או תיקון").fill("בשער חתימת בעלים של רבי משה סופר");
  await page.getByRole("button", { name: "הוספת המידע ב-AI" }).click();
  await expect(page.getByText("ההוספה נשלחה לעיבוד ברקע")).toBeVisible();
  // the first browser leaves the page at once
  await page.goto("/inventory");

  // the second browser learns about it without a manual refresh: processing, who started it, actions locked
  const banner = page2.getByTestId("ai-activity");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("AI בעיבוד - הוספת מידע לתיאור הקטלוגי");
  await expect(banner).toContainText(/הופעל על ידי|הפעלת את העיבוד/);
  await expect(page2.getByRole("button", { name: "הוספת המידע ב-AI" })).toBeDisabled();
  await expect(page2.getByRole("button", { name: "סיום בדיקה ואישור" })).toBeDisabled();

  // ... and when the server finishes, both the description and the state update by themselves
  await expect(banner).toBeHidden({ timeout: 60_000 });
  await expect(page2.getByText(/העיבוד הושלם/)).toBeVisible();
  const editor2 = page2.getByRole("textbox", { name: "תיאור קטלוגי" });
  await expect(editor2).toContainText("בשער חתימת בעלים של רבי משה סופר.", { timeout: 20_000 });
  // the earlier bold stayed, the new important fact is bold too
  await expect(editor2.locator(BOLD)).toHaveText(["הקדשה בכתב ידו של המחבר", "חתימת בעלים של רבי משה סופר"]);

  // the first browser, back on the book, sees the result as saved by the server and can undo it
  await page.goto(`/inventory/${id}`);
  await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" })).toContainText("בשער חתימת בעלים של רבי משה סופר.");
  await page.getByRole("button", { name: "ביטול ההוספה" }).click();
  await expect(page.getByText(/ההוספה בוטלה/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" })).not.toContainText("רבי משה סופר");
  await expect(page.getByRole("textbox", { name: "תיאור קטלוגי" }).locator(BOLD)).toHaveText("הקדשה בכתב ידו של המחבר");
  await other.close();
});
