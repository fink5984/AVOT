import { expect, test, type Page } from "@playwright/test";
import { apiConsignor, login, pickCamera, pickConsignor, resetCapturePrefs, shoot, strip } from "./helpers";

/**
 * Consignors (mandatory on every new book), the photographer's notes (autosave, shortcuts off while typing) and the
 * label queued by "סיום פריט" — through the real UI with Chromium's fake camera.
 */
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const origin = (page: Page) => new URL(page.url()).origin;

async function newBook(page: Page, title: string) {
  const r = await page.request.post("/api/inventory", { data: { title, consignorId: (await apiConsignor(page)).id }, headers: { origin: origin(page) } });
  const { item } = await r.json();
  return item as { id: string; inventoryNumber: string };
}

const labelsOf = async (page: Page, inventoryNumber: string) => {
  const { jobs } = await page.request.get("/api/print/jobs?limit=200").then((r) => r.json());
  return (jobs as { summary: string; status: string }[]).filter((j) => j.summary?.startsWith(inventoryNumber));
};

test("consignors page: create, search by name and phone, edit", async ({ page }) => {
  await login(page);
  await page.goto("/consignors");
  await page.getByRole("button", { name: "הוספת מפקיד" }).click();
  const dialog = page.getByRole("dialog", { name: "מפקיד חדש" });
  await dialog.getByLabel("שם המפקיד").fill(`לקוח ${RUN}`);
  await dialog.getByLabel("טלפון").fill("050-777-6655");
  await dialog.getByRole("button", { name: "שמירת מפקיד" }).click();
  await expect(page.getByRole("link", { name: `לקוח ${RUN}` })).toBeVisible();

  await page.getByRole("searchbox", { name: "חיפוש מפקידים" }).fill("0507776655");
  await expect(page.getByRole("link", { name: `לקוח ${RUN}` })).toBeVisible();
  await page.getByRole("searchbox", { name: "חיפוש מפקידים" }).fill("zzz-no-such");
  await expect(page.getByText("לא נמצאו מפקידים")).toBeVisible();

  await page.goto(`/consignors?q=${encodeURIComponent(`לקוח ${RUN}`)}`);
  await page.getByRole("button", { name: `עריכת לקוח ${RUN}` }).click();
  const edit = page.getByRole("dialog", { name: "עריכת מפקיד" });
  await edit.getByLabel("שם המפקיד").fill(`לקוח ${RUN} (ערוך)`);
  await edit.getByRole("button", { name: "שמירה" }).click();
  await expect(page.getByRole("link", { name: `לקוח ${RUN} (ערוך)` })).toBeVisible();
});

test("a book needs a consignor: the full form keeps what was typed while a consignor is created in place; the API refuses without one", async ({ page }) => {
  await login(page);
  await page.goto("/inventory");
  await page.getByRole("button", { name: "הוספה עם פרטים" }).click();
  const form = page.getByRole("dialog", { name: "ספר חדש למלאי" });
  await form.getByLabel("שם הספר").fill(`ספר מפקיד ${RUN}`);
  await form.getByLabel("מחבר").fill("מחבר שהוקלד");
  await form.getByRole("button", { name: "קליטה למלאי" }).click();
  await expect(form.getByText("יש לבחור מפקיד").first()).toBeVisible(); // nothing was sent

  await form.getByRole("button", { name: "מפקיד חדש" }).click();
  const nested = page.getByRole("dialog", { name: "מפקיד חדש" });
  await nested.getByLabel("שם המפקיד").fill(`מפקיד חדש ${RUN}`);
  await nested.getByRole("button", { name: "שמירת מפקיד" }).click();
  // the form is still there, still filled, and the new consignor is already chosen
  await expect(form.getByRole("combobox", { name: "מפקיד" })).toHaveValue(`מפקיד חדש ${RUN}`);
  await expect(form.getByLabel("שם הספר")).toHaveValue(`ספר מפקיד ${RUN}`);
  await expect(form.getByLabel("מחבר")).toHaveValue("מחבר שהוקלד");
  await form.getByRole("button", { name: "קליטה למלאי" }).click();
  await expect(page).toHaveURL(/\/inventory\/[0-9a-f-]{36}/);
  await expect(page.getByText(`מפקיד חדש ${RUN}`).first()).toBeVisible();

  const res = await page.request.post("/api/inventory", { data: { title: "בלי מפקיד" }, headers: { origin: origin(page) } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.message).toMatch(/מפקיד/);
});

test("capture: notes autosave and Space types a space (no shot); finish queues exactly one label; finish + new book labels the previous book", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);
  await resetCapturePrefs(page);
  const a = await newBook(page, `צילום ${RUN} א`);
  await page.goto(`/capture/${a.id}`);
  await pickCamera(page, /fake_device/i);

  // ── notes: typing spaces must not shoot; saved without a button; restored on reload
  const notes = page.getByRole("textbox", { name: "הערות המצלם" });
  await notes.click();
  await notes.pressSequentially("חסר דף שער ", { delay: 30 });
  await page.keyboard.press("Space");
  await notes.pressSequentially("וקרע בכריכה");
  await expect(notes).toHaveValue("חסר דף שער  וקרע בכריכה");
  await expect(strip(page)).toHaveCount(0);
  const status = page.getByTestId("photographer-notes").getByRole("status");
  await expect(status).toHaveText("נשמר", { timeout: 15_000 });
  const saved = await page.request.get(`/api/inventory/${a.id}/photographer-notes`).then((r) => r.json());
  expect(saved.text).toBe("חסר דף שער  וקרע בכריכה");
  const book = await page.request.get(`/api/inventory/${a.id}`).then((r) => r.json());
  expect(book.item.internalNotes).toBeNull(); // the internal notes are a different field

  // moving away and back (or reloading) shows the notes again
  await page.reload();
  await expect(page.getByRole("textbox", { name: "הערות המצלם" })).toHaveValue("חסר דף שער  וקרע בכריכה");
  await pickCamera(page, /fake_device/i);

  // ── a shot, then finish: one label, honest status, no matter how often the button is hit
  await page.getByRole("textbox", { name: "הערות המצלם" }).blur();
  await shoot(page, 1, "space");
  await page.getByRole("button", { name: "סיום פריט" }).click();
  const finish = page.getByRole("button", { name: "סיום הפריט" });
  await finish.dblclick();
  await expect(page.getByTestId("label-print-status")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("label-print-status")).not.toContainText("הודפסה");
  await expect.poll(async () => (await labelsOf(page, a.inventoryNumber)).length, { timeout: 60_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect((await labelsOf(page, a.inventoryNumber)).length).toBe(1);

  // ── finish and create a new book: the new-book window requires a consignor; the previous book gets the label
  const b = await newBook(page, `צילום ${RUN} ב`);
  await page.goto(`/capture/${b.id}`);
  await pickCamera(page, /fake_device/i);
  await page.getByRole("button", { name: "סיום פריט" }).click();
  await page.getByRole("button", { name: "סיים ספר וצור חדש" }).click();
  const dlg = page.getByRole("dialog", { name: "סיום ספר וספר חדש" });
  await dlg.getByLabel("שם הספר").fill(`ספר חדש מהצילום ${RUN}`);
  await expect(dlg.getByRole("combobox")).toHaveValue(""); // not chosen yet
  await dlg.getByRole("button", { name: "סיום ויצירת ספר" }).click(); // no consignor: refused before anything is finished
  await expect(dlg.getByText("יש לבחור מפקיד").first()).toBeVisible();
  expect((await labelsOf(page, b.inventoryNumber)).length).toBe(0);
  await pickConsignor(dlg);
  await dlg.getByRole("button", { name: "סיום ויצירת ספר" }).click();
  await expect(page).not.toHaveURL(new RegExp(`/capture/${b.id}`), { timeout: 20_000 });
  await expect(page.locator("header").getByText(`ספר חדש מהצילום ${RUN}`)).toBeVisible();
  await expect.poll(async () => (await labelsOf(page, b.inventoryNumber)).length, { timeout: 60_000 }).toBe(1);
  const created = page.url().split("/capture/")[1]!.split("?")[0]!;
  const createdBook = await page.request.get(`/api/inventory/${created}`).then((r) => r.json());
  expect(createdBook.item.consignorId).toBeTruthy();
  expect((await labelsOf(page, createdBook.item.inventoryNumber)).length).toBe(0); // the new book is not printed yet
});
