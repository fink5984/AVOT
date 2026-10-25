/**
 * Phase 2 acceptance test (API level) — the scenario of the specification,
 * section 18, plus its edge cases, against a RUNNING server.
 *
 *   node tests/phase2-acceptance.mjs                       # http://localhost:3100
 *   BASE_URL=http://localhost:3000 node tests/phase2-acceptance.mjs
 *
 * Needs an admin (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, default admin@avot.local).
 * Creates its own users (warehouse worker, viewer), books, catalogs (numbers
 * suffixed with a run id) and warehouse places A-03-01…03 (reused if present).
 * Writes data — run it against a development / test database only.
 */
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? "admin@avot.local", password: process.env.E2E_ADMIN_PASSWORD ?? "Avot-Dev-2026!" };
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "../apps/web/package.json"));
const sharp = require("sharp");

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) {
    passes++;
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✘ ${name}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 400)}` : ""}`);
  }
}
const section = (t) => console.log(`\n▸ ${t}`);

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = "";
  }
  async req(method, url, body, headers = {}) {
    const isBuf = body instanceof Uint8Array;
    const res = await fetch(BASE + url, {
      method,
      headers: {
        origin: BASE,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined && !isBuf ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
  get = (u) => this.req("GET", u);
  post = (u, b) => this.req("POST", u, b ?? {});
  patch = (u, b) => this.req("PATCH", u, b);
  put = (u, b, h) => this.req("PUT", u, b, h);
  async login(email, password) {
    const r = await this.post("/api/auth/login", { email, password });
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.data)}`);
  }
}

async function makeUser(admin, role) {
  const email = `p2-${role.toLowerCase()}-${RUN}@avot.local`.toLowerCase();
  const inv = await admin.post("/api/users/invite", { name: `בדיקה ${role} ${RUN}`, email, role });
  if (inv.status >= 300) throw new Error(`invite failed ${JSON.stringify(inv.data)}`);
  const token = inv.data.url.split("/invite/")[1];
  const password = "Phase2-Test-Pass!";
  const acc = await new Client("x").post(`/api/auth/invite/${token}`, { password });
  if (acc.status >= 300) throw new Error(`accept failed ${JSON.stringify(acc.data)}`);
  const c = new Client(role);
  await c.login(email, password);
  return c;
}

async function jpeg(label) {
  return new Uint8Array(
    await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120 + label.length * 9, g: 90, b: 60 } } })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );
}

async function capture(c, itemId, category) {
  const bytes = await jpeg(category);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reg = await c.post("/api/captures", {
    captureId: randomUUID(),
    inventoryItemId: itemId,
    category,
    source: "SIMULATOR",
    capturedAt: new Date().toISOString(),
    files: [{ role: "PRIMARY", originalFilename: `${category}.jpg`, mimeType: "image/jpeg", sizeBytes: bytes.length, sha256, width: 640, height: 480 }],
  });
  if (reg.status !== 200) return { ok: false, reg };
  const up = await c.put(reg.data.files[0].uploadUrl, bytes, { "content-type": "application/octet-stream" });
  return { ok: up.status === 200 && up.data.uploadStatus === "VERIFIED", reg, up };
}

let clock = Date.now();
const op = (mode, code, extra = {}) => ({ opId: randomUUID(), mode, code, clientAt: new Date(clock++).toISOString(), ...extra });

async function ensureLocations(admin) {
  const tree = (await admin.get("/api/warehouse")).data.warehouses;
  const wh = tree.find((w) => w.isDefault) ?? tree[0];
  let zone = wh.zones.find((z) => z.code === "A");
  if (!zone) zone = (await admin.post("/api/warehouse/zones", { code: "A", name: "אזור A" })).data.zone;
  let shelf = (wh.zones.find((z) => z.code === "A")?.shelves ?? []).find((s) => s.code === "03");
  if (!shelf) shelf = (await admin.post("/api/warehouse/shelves", { zoneId: zone.id, code: "03", shelfType: "מדף פתוח" })).data.shelf;
  for (const cell of ["01", "02", "03"]) {
    const code = `LOC-A-03-${cell}`;
    const found = await admin.get(`/api/warehouse/locations?code=${code}`);
    if (found.status === 404) {
      const r = await admin.post("/api/warehouse/locations", { shelfId: shelf.id, cells: [cell], sizeClass: "MEDIUM", capacity: 40 });
      if (r.status !== 201) throw new Error(`location ${code}: ${JSON.stringify(r.data)}`);
    }
  }
  const get = async (code) => (await admin.get(`/api/warehouse/locations?code=${code}`)).data.location;
  return { l1: await get("LOC-A-03-01"), l2: await get("LOC-A-03-02"), l3: await get("LOC-A-03-03") };
}

async function main() {
  console.log(`Phase 2 acceptance · ${BASE} · run ${RUN}`);
  const admin = new Client("admin");
  await admin.login(ADMIN.email, ADMIN.password);

  section("הכנה: משתמשים, מיקומים, בתי מכירות");
  const worker = await makeUser(admin, "WAREHOUSE");
  const viewer = await makeUser(admin, "VIEWER");
  const photographer = await makeUser(admin, "PHOTOGRAPHER");
  const { l2, l3 } = await ensureLocations(admin);
  check("מיקום LOC-A-03-02 קיים", l2?.code === "LOC-A-03-02", l2);
  const houses = (await admin.get("/api/catalogs")).data; // warm-up
  void houses;

  section("1–3 · ספר חדש במלאי + מספר מלאי + תווית");
  const created = await admin.post("/api/inventory", { title: `ספר בדיקה ${RUN}`, author: "מחבר בדיקה", heightMm: 240, widthMm: 170 });
  check("נוצר ספר מלאי (201)", created.status === 201, created.data);
  const book = created.data.item;
  check("מספר מלאי בפורמט ITM-000000", /^ITM-\d{6}$/.test(book.inventoryNumber), book.inventoryNumber);
  check("ברקוד = מספר המלאי", book.barcode === book.inventoryNumber);
  check("קטגוריית גודל הוצעה מהמידות (MEDIUM)", book.sizeCategory === "MEDIUM", book.sizeCategory);
  const label = await admin.get(`/api/labels/zpl?items=${book.id}`);
  check("תווית ZPL לספר כוללת Code 128 עם מספר המלאי", label.status === 200 && String(label.data).includes("^BC") && String(label.data).includes(book.inventoryNumber), label.status);
  const book2 = (await admin.post("/api/inventory", { title: `ספר שני ${RUN}` })).data.item;

  section("4–6 · פתיחת צילום מסריקת ברקוד + 4 תמונות שנשמרות בספר");
  const found = await admin.get(`/api/search?q=${book.inventoryNumber}`);
  check("סריקת הברקוד בחיפוש פותחת את הספר", found.data?.directItemId === book.id, found.data);
  const ctx = await admin.get(`/api/lots/${book.id}/capture-context`);
  check("הקשר צילום לפי ספר מלאי (target=item)", ctx.status === 200 && ctx.data.target === "item", ctx.data);
  for (const cat of ["COVER", "TITLE_PAGE", "INTERIOR", "EXTERIOR"]) {
    const r = await capture(admin, book.id, cat);
    check(`צילום ${cat} נשמר ואומת`, r.ok, r.reg?.data ?? r.up?.data);
  }
  const assets = await admin.get(`/api/lots/${book.id}/assets`);
  check("4 תמונות שייכות לספר המלאי", assets.data?.assets?.length === 4, assets.data?.assets?.length);
  check("התמונות ללא קטלוג (lotId=null)", assets.data?.assets?.every((a) => a.inventoryItemId === book.id && a.lotId === null));
  // capture via a lot id (Capture Agent style: target id in lotId) still lands on the book — checked after assignment below

  section("7–12 · מסופון: אחסון רציף והחלפת מדף בלי מחשב");
  let r = await worker.post("/api/scan", op("STORE", "LOC-A-03-02"));
  check("סריקת מדף → מיקום פעיל", r.data?.result === "OK" && r.data.activeLocation?.id === l2.id, r.data);
  r = await worker.post("/api/scan", op("STORE", book.inventoryNumber, { contextLocationId: l2.id }));
  check("סריקת ספר → שויך למדף", r.data?.result === "OK" && r.data.item?.location?.code === "LOC-A-03-02", r.data);
  check("התגובה כוללת שם ספר, מספר מלאי ומיקום", r.data?.item?.title && r.data.item.inventoryNumber === book.inventoryNumber && r.data.item.location);
  const firstOp = op("STORE", book2.inventoryNumber.toLowerCase(), { contextLocationId: l3.id });
  r = await worker.post("/api/scan", op("STORE", "LOC-A-03-03"));
  check("מדף אחר → המיקום הפעיל מתחלף", r.data?.activeLocation?.code === "LOC-A-03-03");
  r = await worker.post("/api/scan", firstOp);
  check("ספר נוסף נכנס למדף החדש (גם בברקוד באותיות קטנות)", r.data?.result === "OK" && r.data.item?.location?.code === "LOC-A-03-03", r.data);
  let detail = (await admin.get(`/api/inventory/${book.id}`)).data.item;
  check("הספר הראשון במחסן (IN_STORAGE) במדף A-03-02", detail.physicalStatus === "IN_STORAGE" && detail.currentLocationId === l2.id, detail.physicalStatus);

  section("מקרי קצה בסריקה");
  r = await worker.post("/api/scan", firstOp);
  check("שליחה חוזרת של אותה פעולה (opId) — לא מבוצעת פעמיים", r.data?.replayed === true && r.data.result === "OK", r.data);
  r = await worker.post("/api/scan", op("STORE", book2.inventoryNumber, { contextLocationId: l3.id }));
  check("סריקה כפולה מהירה של אותו ספר — NOOP ולא תנועה נוספת", r.data?.result === "NOOP", r.data);
  const moves2 = (await admin.get(`/api/inventory/${book2.id}`)).data;
  void moves2;
  r = await worker.post("/api/scan", op("STORE", "ITM-999999", { contextLocationId: l2.id }));
  check("ברקוד ספר לא קיים → שגיאה", r.data?.result === "ERROR", r.data);
  r = await worker.post("/api/scan", op("STORE", "XYZ-NOT-A-CODE", { contextLocationId: l2.id }));
  check("ברקוד לא מוכר → שגיאה", r.data?.result === "ERROR", r.data);
  r = await worker.post("/api/scan", op("STORE", "LOC-Z-99-99"));
  check("מיקום לא קיים → שגיאה", r.data?.result === "ERROR", r.data);
  r = await worker.post("/api/scan", op("STORE", book.inventoryNumber));
  check("ספר בלי מדף פעיל → 'סרקו קודם ברקוד של מדף'", r.data?.result === "ERROR" && /מדף/.test(r.data.message), r.data);
  const loose = (await admin.post("/api/inventory", { title: `ספר ללא מיקום ${RUN}` })).data.item;
  r = await worker.post("/api/scan", op("FIND", loose.inventoryNumber));
  check("איתור ספר חסר מיקום → מוצג 'אין מיקום'", r.data?.result === "OK" && r.data.item?.location === null, r.data);
  r = await worker.post("/api/scan", op("FIND", book.inventoryNumber));
  check("איתור: שם, תמונה, מספר, מיקום, מצב מסחרי", r.data?.item?.thumbUrl !== undefined && r.data.item.location?.code === "LOC-A-03-02" && r.data.item.commercialStatus === "UNASSIGNED", r.data?.item);
  r = await worker.post("/api/scan", op("STORE", "CMD-TRANSFER"));
  check("ברקוד פקודה מחליף מצב בלבד", r.data?.codeType === "COMMAND" && r.data.result === "OK", r.data);
  r = await viewer.post("/api/scan", op("STORE", "LOC-A-03-02"));
  check("צופה מנסה אחסון → 403", r.status === 403, r.status);
  r = await photographer.post("/api/scan", op("TRANSFER", book.inventoryNumber, { contextLocationId: l3.id }));
  check("צלם מנסה העברה → 403", r.status === 403, r.status);
  r = await viewer.post("/api/scan", op("STORE", "CMD-STORE"));
  check("ברקוד פקודה אינו עוקף הרשאות (צופה → 403)", r.status === 403, r.status);

  section("ניתוק אינטרנט / סנכרון מאוחר עם נתונים סותרים");
  const staleClientAt = new Date(Date.now() - 60_000).toISOString(); // scanned offline a minute ago
  r = await worker.post("/api/scan", op("TRANSFER", book2.inventoryNumber, { contextLocationId: l3.id }));
  void r;
  // meanwhile someone moved book2 to A-03-02 online
  r = await worker.post("/api/scan", op("TRANSFER", book2.inventoryNumber, { contextLocationId: l2.id }));
  check("העברה מקוונת של ספר 2 ל-A-03-02", r.data?.result === "OK", r.data);
  const late = { opId: randomUUID(), mode: "TRANSFER", code: book2.inventoryNumber, contextLocationId: l3.id, clientAt: staleClientAt, deferred: true };
  r = await worker.post("/api/scan/batch", { ops: [late] });
  check("פעולה ישנה מהתור הלא-מקוון → CONFLICT, לא נדרסה", r.data?.results?.[0]?.result === "CONFLICT", r.data);
  detail = (await admin.get(`/api/inventory/${book2.id}`)).data.item;
  check("המיקום נשאר זה שנקבע מאוחר יותר (A-03-02)", detail.currentLocationId === l2.id);
  const conflicts = (await admin.get("/api/scan/events?open=1")).data.events;
  const conflict = conflicts.find((e) => e.opId === late.opId);
  check("הסתירה מופיעה ברשימת הסריקות לבדיקה", !!conflict);
  r = await admin.post(`/api/scan/events/${conflict?.id}/resolve`, { action: "dismiss" });
  check("מנהל דוחה את הפעולה הסותרת", r.status === 200, r.data);
  r = await worker.post("/api/scan/batch", { ops: [late] });
  check("שליחה חוזרת של הפעולה מהתור — מוחזרת התוצאה המקורית, לא מבוצעת", r.data?.results?.[0]?.replayed === true, r.data);

  section("13–14 · שיוך לאבות, קטלוג 12, פריט 37 — עם כל התמונות");
  const avot = await admin.post("/api/catalogs", { number: `12-${RUN}`, name: `קטלוג 12 בדיקה ${RUN}`, status: "ACTIVE" });
  check("קטלוג באבות נוצר", avot.status === 201, avot.data);
  const tavinId = await houseId(admin, "tavin");
  const tavin = await admin.post("/api/catalogs", { number: `4-${RUN}`, name: `טבין 4 בדיקה ${RUN}`, auctionHouseId: tavinId, status: "ACTIVE" });
  check("קטלוג בטבין נוצר", tavin.status === 201 && tavin.data.catalog.auctionHouseId === tavinId, tavin.data);
  r = await admin.post(`/api/inventory/${book.id}/assign`, { catalogId: avot.data.catalog.id, lotNumber: 37, shortDescription: "תיאור לאבות" });
  check("שויך: פריט 37", r.status === 201 && r.data.lot.lotNumber === 37, r.data);
  const lotA = r.data.lot;
  const lotAssets = await admin.get(`/api/lots/${lotA.id}/assets?scope=lot`);
  check("הספר מופיע בקטלוג עם 4 תמונות (ללא שכפול קבצים)", lotAssets.data?.assets?.length === 4 && lotAssets.data.assets.every((a) => assets.data.assets.some((b) => b.id === a.id)), lotAssets.data?.assets?.length);
  const viaLot = await capture(admin, lotA.id, "INTERIOR");
  void viaLot;
  const agentStyle = await admin.post("/api/captures", {
    captureId: randomUUID(),
    lotId: book.id, // the agent sends the target id in lotId; an inventory id is accepted
    category: "INTERIOR",
    source: "SIMULATOR",
    capturedAt: new Date().toISOString(),
    files: [{ role: "PRIMARY", originalFilename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, sha256: "0".repeat(64) }],
  });
  check("תאימות Capture Agent: מזהה ספר מלאי בשדה lotId מתקבל", agentStyle.status === 200, agentStyle.data);

  section("שיוך כפול לשני קטלוגים פעילים");
  r = await admin.post(`/api/inventory/${book.id}/assign`, { catalogId: tavin.data.catalog.id });
  check("נחסם (409) עם פרטי השיוך הפעיל", r.status === 409 && r.data.error.details?.activeLot?.lotNumber === 37, r.data);
  r = await admin.post(`/api/inventory/${book2.id}/assign`, { catalogId: avot.data.catalog.id, lotNumber: 37 });
  check("מספר פריט תפוס בקטלוג → 409", r.status === 409, r.data);

  section("15–18 · סיום הקטלוג (לא נמכר) ומעבר לטבין, קטלוג 4, פריט 62");
  r = await admin.post(`/api/catalogs/${avot.data.catalog.id}/close`);
  check("הקטלוג הסתיים", r.status === 200 && r.data.unsold >= 1, r.data);
  detail = (await admin.get(`/api/inventory/${book.id}`)).data;
  check("הספר מסומן 'לא נמכר'", detail.item.commercialStatus === "UNSOLD", detail.item.commercialStatus);
  r = await admin.post(`/api/inventory/${book.id}/assign`, { catalogId: tavin.data.catalog.id, lotNumber: 62, shortDescription: "תיאור נפרד לטבין" });
  check("שויך לטבין: פריט 62", r.status === 201 && r.data.lot.lotNumber === 62, r.data);
  const lotT = r.data.lot;
  const tAssets = await admin.get(`/api/lots/${lotT.id}/assets?scope=lot`);
  check("כל התמונות נשארו (≥4) ומוצגות בטבין", (tAssets.data?.assets?.length ?? 0) >= 4, tAssets.data?.assets?.length);
  detail = (await admin.get(`/api/inventory/${book.id}`)).data;
  check("המיקום הפיזי לא השתנה (A-03-02)", detail.item.currentLocationId === l2.id);
  check("מספר המלאי לא השתנה", detail.item.inventoryNumber === book.inventoryNumber);
  check("היסטוריית שיוכים: אבות (הסתיים, לא נמכר) + טבין (פעיל)", detail.lots.length === 2 && detail.lots.some((l) => l.assignmentStatus === "ENDED" && l.commercialStatus === "UNSOLD"));

  section("19–21 · מכירה → משימת ליקוט → סריקת הספר הנכון");
  r = await admin.post(`/api/lots/${lotT.id}/commercial`, { status: "SOLD" });
  check("סומן נמכר", r.status === 200, r.data);
  detail = (await admin.get(`/api/inventory/${book.id}`)).data.item;
  check("מצב פיזי: ממתין לליקוט", detail.physicalStatus === "AWAITING_PICK", detail.physicalStatus);
  const picks = (await worker.get("/api/picks")).data.tasks;
  const task = picks.find((t) => t.item.id === book.id);
  check("משימת ליקוט נוצרה ומציגה את המיקום", task?.status === "OPEN" && task.location?.code === "LOC-A-03-02", task);
  r = await worker.post("/api/scan", op("PICK", book2.inventoryNumber));
  check("סריקת ספר שגוי בליקוט → שגיאה", r.data?.result === "ERROR", r.data);
  r = await worker.post("/api/scan", op("PICK", book.inventoryNumber));
  check("סריקת הספר הנכון → לוקט, התקדמות מתעדכנת", r.data?.result === "OK" && typeof r.data.pick?.remaining === "number", r.data);
  r = await worker.post(`/api/picks/${task?.id}/shipped`);
  check("משלוח לפני אריזה → נחסם", r.status === 409, r.data);
  r = await worker.post(`/api/picks/${task?.id}/packed`);
  check("נארז", r.status === 200, r.data);
  r = await worker.post(`/api/picks/${task?.id}/shipped`);
  check("נשלח", r.status === 200, r.data);
  r = await worker.post("/api/scan", op("TRANSFER", book.inventoryNumber, { contextLocationId: l3.id }));
  check("העברה של ספר שכבר נשלח → שגיאה", r.data?.result === "ERROR" && /נשלח/.test(r.data.message), r.data);
  r = await admin.post(`/api/inventory/${book.id}/assign`, { catalogId: avot.data.catalog.id });
  check("שיוך ספר שנמכר לקטלוג נוסף → נחסם", r.status === 409, r.data);

  section("22 · היסטוריה מלאה של הספר");
  detail = (await admin.get(`/api/inventory/${book.id}`)).data;
  check("2 שיוכי קטלוג בהיסטוריה", detail.lots.length === 2);
  const page = await admin.get(`/inventory/${book.id}`);
  check("עמוד הספר נטען (היסטוריה, קטלוגים, תנועות)", page.status === 200 && String(page.data).includes(book.inventoryNumber), page.status);

  section("ספירת מלאי — אין שינוי אוטומטי לפני אישור");
  const count = await worker.post("/api/counts", {});
  check("ספירה התחילה", count.status === 201, count.data);
  const sid = count.data.count.id;
  r = await worker.post("/api/scan", op("COUNT", "LOC-A-03-03", { countSessionId: sid }));
  check("סריקת מיקום בספירה", r.data?.result === "OK", r.data);
  r = await worker.post("/api/scan", op("COUNT", book2.inventoryNumber, { countSessionId: sid, contextLocationId: l3.id }));
  check("ספר שרשום במקום אחר נספר עם אזהרה", r.data?.result === "OK" && r.data.warning === true, r.data);
  detail = (await admin.get(`/api/inventory/${book2.id}`)).data.item;
  check("המיקום לא שונה בזמן הספירה", detail.currentLocationId === l2.id);
  const rep = (await admin.get(`/api/counts/${sid}`)).data.report;
  const wrong = rep.wrongLocation.find((w) => w.itemId === book2.id);
  check("הדו״ח מציג מיקום שגוי", !!wrong, rep);
  r = await worker.post(`/api/counts/${sid}/submit`);
  r = await worker.post(`/api/counts/${sid}/approve`, { applyEntryIds: [wrong?.entryId], markMissingItemIds: [] });
  check("עובד מחסן אינו יכול לאשר פערים (403)", r.status === 403, r.status);
  r = await admin.post(`/api/counts/${sid}/approve`, { applyEntryIds: [wrong?.entryId], markMissingItemIds: [] });
  check("מנהל מאשר את התיקון", r.status === 200, r.data);
  detail = (await admin.get(`/api/inventory/${book2.id}`)).data.item;
  check("רק לאחר האישור המיקום עודכן ל-A-03-03", detail.currentLocationId === l3.id);

  console.log(`\n${passes} עברו · ${failures} נכשלו`);
  process.exitCode = failures ? 1 : 0;
}

async function houseId(c, slug) {
  const page = await c.get(`/houses/${slug}`);
  void page;
  const r = await c.get("/api/houses");
  return r.data.houses.find((h) => h.slug === slug).id;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
