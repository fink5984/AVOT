import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { createCatalog } from "@/server/services/catalogs";
import { createLot, duplicateLot, moveLotToCatalog } from "@/server/services/lots";
import { assignToCatalog } from "@/server/services/assignments";
import { createItem, listInventory, setItemPhotoStatus, updateItem } from "@/server/services/inventory";
import { createConsignor, deleteConsignor, getConsignor, listConsignors, updateConsignor } from "@/server/services/consignors";
import { importItems, importLots } from "@/server/services/csv-import";
import { savePhotographerNotes } from "@/server/services/photographer-notes";
import { finishCapture } from "@/server/services/capture-finish";
import { loadCaptureContext } from "@/server/services/capture-context";
import { claimNextPrintJob, createPrinter, describePrintJob, reportPrintJob } from "@/server/services/printing";
import { hasDb, makeOrg, pairAgent } from "./helpers";

describe.skipIf(!hasDb)("consignors, photographer notes, label on finish (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let other: Awaited<ReturnType<typeof makeOrg>>;
  let anna: { id: string };
  let boaz: { id: string };

  beforeAll(async () => {
    ctx = await makeOrg("cons");
    other = await makeOrg("cons-other");
    anna = await createConsignor(ctx.editor, { name: "אנה כהן", phone: "050-123-4567", email: "anna@example.com" });
    boaz = await createConsignor(ctx.editor, { name: "בועז לוי", phone: "+1 (212) 555-0100" });
  });

  /* ───────────── the consignor entity ───────────── */
  describe("consignors", () => {
    it("name is required, e-mail is validated when given, phone and notes are optional", async () => {
      await expect(createConsignor(ctx.editor, { name: "  " })).rejects.toThrow();
      await expect(createConsignor(ctx.editor, { name: "x", email: "not-an-email" })).rejects.toThrow();
      const c = await createConsignor(ctx.photographer, { name: "חברת ספרים בע״מ", notes: "הערה" });
      expect(c.phone).toBeNull();
      expect(c.email).toBeNull();
      expect(c.bookCount).toBe(0);
    });

    it("searches by name, by phone (digits only, any punctuation) and by e-mail", async () => {
      const names = async (q: string) => (await listConsignors(ctx.editor, { q })).consignors.map((c) => c.name);
      expect(await names("אנה")).toContain("אנה כהן");
      expect(await names("0501234567")).toContain("אנה כהן");
      expect(await names("123-45")).toContain("אנה כהן");
      expect(await names("2125550100")).toContain("בועז לוי");
      expect(await names("anna@")).toContain("אנה כהן");
      expect(await names("אנה")).not.toContain("בועז לוי");
    });

    it("is isolated per organization", async () => {
      await expect(getConsignor(other.admin, anna.id)).rejects.toThrow(/לא נמצא/);
      expect((await listConsignors(other.admin, { q: "אנה" })).consignors).toHaveLength(0);
      await expect(updateConsignor(other.admin, anna.id, { name: "פרוץ" })).rejects.toThrow(/לא נמצא/);
    });

    it("permissions: photographers may create but not manage; warehouse staff do not see contact details", () => {
      expect(can("PHOTOGRAPHER", "consignor.create")).toBe(true);
      expect(can("PHOTOGRAPHER", "consignor.manage")).toBe(false);
      expect(can("EDITOR", "consignor.manage")).toBe(true);
      expect(can("WAREHOUSE", "consignor.view")).toBe(false);
      expect(can("VIEWER", "consignor.create")).toBe(false);
    });
  });

  /* ───────────── no new book without a consignor, on every path ───────────── */
  describe("a consignor is mandatory for every new book (server side)", () => {
    let catalog: { id: string };
    beforeAll(async () => {
      catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "C1", name: "קטלוג מפקידים" });
    });

    it("createItem: missing, unknown, foreign and archived consignors are refused", async () => {
      await expect(createItem(ctx.editor, { title: "בלי מפקיד" })).rejects.toThrow(/יש לבחור מפקיד/);
      await expect(createItem(ctx.editor, { title: "לא קיים", consignorId: randomUUID() })).rejects.toThrow(/לא נמצא/);
      const foreign = await createConsignor(other.admin, { name: "של ארגון אחר" });
      await expect(createItem(ctx.editor, { title: "זר", consignorId: foreign.id })).rejects.toThrow(/לא נמצא/);
      const old = await createConsignor(ctx.editor, { name: "בארכיון" });
      await updateConsignor(ctx.editor, old.id, { archived: true });
      await expect(createItem(ctx.editor, { title: "בארכיון", consignorId: old.id })).rejects.toThrow(/בארכיון/);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id, title: { in: ["בלי מפקיד", "לא קיים", "זר", "בארכיון"] } } })).toBe(0);
    });

    it("creates the book with its consignor (and the retry key still makes one book)", async () => {
      const opId = randomUUID();
      const [a, b] = await Promise.all([createItem(ctx.photographer, { title: "עם מפקיד", consignorId: anna.id, opId }), createItem(ctx.photographer, { title: "עם מפקיד", consignorId: anna.id, opId })]);
      expect(a.item.id).toBe(b.item.id);
      expect(a.item.consignorId).toBe(anna.id);
      expect((await getConsignor(ctx.editor, anna.id)).bookCount).toBeGreaterThanOrEqual(1);
    });

    it("catalog quick add / full form (createLot) refuses without a consignor and stores it on the physical book", async () => {
      await expect(createLot(ctx.editor, catalog.id, { title: "בלי מפקיד בקטלוג" })).rejects.toThrow(/יש לבחור מפקיד/);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id, title: "בלי מפקיד בקטלוג" } })).toBe(0);
      expect(await db.lot.count({ where: { catalogId: catalog.id } })).toBe(0);
      const lot = await createLot(ctx.editor, catalog.id, { title: "בקטלוג", consignorId: boaz.id });
      const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: lot.inventoryItemId } });
      expect(item.consignorId).toBe(boaz.id);
    });

    it("an additional physical copy needs its own consignor — never copied from the first", async () => {
      const lot = await createLot(ctx.editor, catalog.id, { title: "עותק ראשון", consignorId: anna.id });
      await expect(duplicateLot(ctx.editor, lot.id, undefined)).rejects.toThrow(/יש לבחור מפקיד/);
      const copy = await duplicateLot(ctx.editor, lot.id, boaz.id);
      const [first, second] = await Promise.all([db.inventoryItem.findUniqueOrThrow({ where: { id: lot.inventoryItemId } }), db.inventoryItem.findUniqueOrThrow({ where: { id: copy.inventoryItemId } })]);
      expect(first.consignorId).toBe(anna.id);
      expect(second.consignorId).toBe(boaz.id);
    });

    it("the consignor stays with the book when it moves between catalogs", async () => {
      const cat2 = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "C2", name: "אחר" });
      const tavin = await createCatalog(ctx.editor, { auctionHouseId: ctx.house2.id, number: "T1", name: "טבין" });
      const lot = await createLot(ctx.editor, catalog.id, { title: "נודד", consignorId: anna.id });
      const moved = await moveLotToCatalog(ctx.editor, lot.id, cat2.id);
      const again = await assignToCatalog(ctx.editor, moved.inventoryItemId, { catalogId: tavin.id, replaceActive: true });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: again.inventoryItemId } })).consignorId).toBe(anna.id);
    });

    it("books that predate consignors are untouched, listed as 'no consignor', and can be completed later with an audit entry", async () => {
      const serial = 990_001n;
      const legacy = await db.inventoryItem.create({ data: { organizationId: ctx.org.id, serial, inventoryNumber: "10990001", barcode: "10990001", title: "ספר ישן", requirements: {} } });
      expect(legacy.consignorId).toBeNull();
      const noConsignor = await listInventory(ctx.editor, { view: "no_consignor", pageSize: 500 });
      expect(noConsignor.items.map((i) => i.id)).toContain(legacy.id);
      // other edits of a legacy book do not demand a consignor
      await updateItem(ctx.editor, legacy.id, { author: "מחבר" });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: legacy.id } })).consignorId).toBeNull();
      await updateItem(ctx.editor, legacy.id, { consignorId: anna.id });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: legacy.id } })).consignorId).toBe(anna.id);
      const entry = await db.auditLog.findFirst({ where: { inventoryItemId: legacy.id, action: "inventory.consignor_changed" } });
      expect(entry?.userId).toBe(ctx.editor.userId);
      expect(entry?.data).toMatchObject({ from: null, to: "אנה כהן" });
      // the identity of the book is unchanged
      const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(after.inventoryNumber).toBe("10990001");
      expect(after.serial).toBe(serial);
    });

    it("changing the consignor to an unknown / foreign / archived one is refused", async () => {
      const { item } = await createItem(ctx.editor, { title: "להחלפה", consignorId: anna.id });
      await expect(updateItem(ctx.editor, item.id, { consignorId: randomUUID() })).rejects.toThrow(/לא נמצא/);
      const foreign = await createConsignor(other.admin, { name: "זר 2" });
      await expect(updateItem(ctx.editor, item.id, { consignorId: foreign.id })).rejects.toThrow(/לא נמצא/);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).consignorId).toBe(anna.id);
    });

    it("a consignor with books is archived, never deleted; an empty one can be deleted", async () => {
      await expect(deleteConsignor(ctx.editor, anna.id)).rejects.toThrow(/ספרים משויכים/);
      const empty = await createConsignor(ctx.editor, { name: "ריק" });
      await deleteConsignor(ctx.editor, empty.id);
      await expect(getConsignor(ctx.editor, empty.id)).rejects.toThrow();
      const solo = await createConsignor(ctx.editor, { name: "מתארכב" });
      await createItem(ctx.editor, { title: "של מתארכב", consignorId: solo.id });
      await updateConsignor(ctx.editor, solo.id, { archived: true });
      expect((await getConsignor(ctx.editor, solo.id)).bookCount).toBe(1);
      expect((await listConsignors(ctx.editor, {})).consignors.map((c) => c.id)).not.toContain(solo.id);
      expect((await listConsignors(ctx.editor, { includeArchived: true })).consignors.map((c) => c.id)).toContain(solo.id);
    });

    it("the consignor card lists exactly that consignor's books", async () => {
      const mine = await createConsignor(ctx.editor, { name: "לכרטיס" });
      const a = (await createItem(ctx.editor, { title: "כרטיס א", consignorId: mine.id })).item;
      const b = (await createItem(ctx.editor, { title: "כרטיס ב", consignorId: mine.id })).item;
      await createItem(ctx.editor, { title: "של מישהו אחר", consignorId: boaz.id });
      const rows = await listInventory(ctx.editor, { consignorId: mine.id, pageSize: 100 });
      expect(rows.items.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
      expect(rows.items[0]!.consignor?.name).toBe("לכרטיס");
    });
  });

  /* ───────────── CSV import ───────────── */
  describe("CSV import keeps the rule", () => {
    const csv = (rows: string[]) => ["שם ספר,מפקיד,מחבר", ...rows].join("\n");

    it("a missing / unknown / ambiguous / archived consignor is a clear per-line error and nothing is imported", async () => {
      await createConsignor(ctx.editor, { name: "כפול" });
      await createConsignor(ctx.editor, { name: "כפול" });
      const gone = await createConsignor(ctx.editor, { name: "ארכיון CSV" });
      await updateConsignor(ctx.editor, gone.id, { archived: true });
      const text = csv(["ספר תקין,אנה כהן,א", "בלי מפקיד,,ב", "לא קיים,אין כזה,ג", "אמביוולנטי,כפול,ד", "בארכיון,ארכיון CSV,ה"]);
      const preview = await importItems(ctx.editor, text, true);
      expect(preview.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
      expect(preview.errors[0]!.message).toMatch(/חסר מפקיד/);
      expect(preview.errors[1]!.message).toMatch(/לא נמצא/);
      expect(preview.errors[2]!.message).toMatch(/חד-משמעי/);
      expect(preview.errors[3]!.message).toMatch(/בארכיון/);
      const real = await importItems(ctx.editor, text, false);
      expect(real.imported).toBe(0);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id, title: "ספר תקין" } })).toBe(0);
    });

    it("imports into inventory and into a catalog with the consignor on the physical book (matched by name, case / spacing tolerant)", async () => {
      const r = await importItems(ctx.editor, csv(["ייבוא א,אנה  כהן,מחבר", "ייבוא ב,בועז לוי,מחבר"]), false);
      expect(r.imported).toBe(2);
      const a = await db.inventoryItem.findFirstOrThrow({ where: { organizationId: ctx.org.id, title: "ייבוא א" } });
      expect(a.consignorId).toBe(anna.id);

      const cat = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: "CSV", name: "ייבוא" });
      const l = await importLots(ctx.editor, cat.id, csv(["קטלוג א,בועז לוי,מחבר"]), false);
      expect(l.imported).toBe(1);
      const lot = await db.lot.findFirstOrThrow({ where: { catalogId: cat.id }, include: { item: true } });
      expect(lot.item.consignorId).toBe(boaz.id);
    });

    it("a file without a consignor column cannot create books", async () => {
      const r = await importItems(ctx.editor, "שם ספר,מחבר\nבלי עמודה,מחבר", false);
      expect(r.imported).toBe(0);
      expect(r.errors[0]!.message).toMatch(/חסר מפקיד/);
    });

    it("consignors of other organizations are invisible to the import", async () => {
      await createConsignor(other.admin, { name: "רק בארגון השני" });
      const r = await importItems(ctx.editor, csv(["x,רק בארגון השני,y"]), true);
      expect(r.errors[0]!.message).toMatch(/לא נמצא/);
    });
  });

  /* ───────────── photographer notes ───────────── */
  describe("photographer notes", () => {
    let itemId: string;
    beforeAll(async () => {
      itemId = (await createItem(ctx.editor, { title: "להערות", consignorId: anna.id, internalNotes: "הערה פנימית קיימת" })).item.id;
    });

    it("saves separately from internalNotes, with time and user", async () => {
      const r = await savePhotographerNotes(ctx.photographer, itemId, { text: "חסר דף שער", rev: 1000 });
      expect(r.applied).toBe(true);
      const row = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(row.photographerNotes).toBe("חסר דף שער");
      expect(row.internalNotes).toBe("הערה פנימית קיימת");
      expect(row.photographerNotesById).toBe(ctx.photographer.userId);
      expect(row.photographerNotesAt).not.toBeNull();
    });

    it("a delayed older save never overwrites a newer note (any arrival order)", async () => {
      await savePhotographerNotes(ctx.photographer, itemId, { text: "גרסה 3", rev: 3000 });
      const late = await savePhotographerNotes(ctx.photographer, itemId, { text: "גרסה 2 מאוחרת", rev: 2000 });
      expect(late.applied).toBe(false);
      expect(late.state.text).toBe("גרסה 3");
      const same = await savePhotographerNotes(ctx.photographer, itemId, { text: "אותו מספר", rev: 3000 });
      expect(same.applied).toBe(false);
      const newer = await savePhotographerNotes(ctx.photographer, itemId, { text: "גרסה 4", rev: 4000 });
      expect(newer.applied).toBe(true);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).photographerNotes).toBe("גרסה 4");
    });

    it("an editing burst leaves one audit entry, not one per save", async () => {
      const book = (await createItem(ctx.editor, { title: "ביקורת", consignorId: anna.id })).item.id;
      for (let i = 1; i <= 6; i++) await savePhotographerNotes(ctx.photographer, book, { text: "x".repeat(i), rev: i * 10 });
      expect(await db.auditLog.count({ where: { inventoryItemId: book, action: "inventory.photographer_notes" } })).toBe(1);
    });

    it("clearing the text stores null; the book of another organization is unreachable", async () => {
      await savePhotographerNotes(ctx.photographer, itemId, { text: "   ", rev: 9000 });
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).photographerNotes).toBeNull();
      await expect(savePhotographerNotes(other.photographer, itemId, { text: "פרצה", rev: 99999 })).rejects.toThrow(/לא נמצא/);
    });

    it("a photographer may edit the notes without the right to edit inventory", () => {
      expect(can("PHOTOGRAPHER", "photographerNotes.edit")).toBe(true);
      expect(can("PHOTOGRAPHER", "inventory.edit")).toBe(false);
      expect(can("VIEWER", "photographerNotes.edit")).toBe(false);
      expect(can("WAREHOUSE", "photographerNotes.edit")).toBe(false);
    });

    it("the capture context carries the notes and the consignor every time a book is opened", async () => {
      await savePhotographerNotes(ctx.photographer, itemId, { text: "נפתח מחדש", rev: 20_000 });
      const c = await loadCaptureContext(ctx.org.id, itemId);
      expect(c?.item.photographerNotes).toBe("נפתח מחדש");
      expect(c?.item.photographerNotesRev).toBe(20_000);
      expect(c?.item.consignor?.name).toBe("אנה כהן");
    });
  });

  /* ───────────── finishing a book queues exactly one label ───────────── */
  describe("finishing a book in the capture studio", () => {
    let agent: Awaited<ReturnType<typeof pairAgent>>;
    let printerId: string;
    let jobsOf: (itemId: string) => Promise<{ id: string; status: string; printerId: string | null }[]>;
    let org: Awaited<ReturnType<typeof makeOrg>>;
    const book = async (title: string) => (await createItem(org.photographer, { title, consignorId: (await createConsignor(org.editor, { name: `מפקיד ${title}` })).id })).item;

    beforeAll(async () => {
      org = await makeOrg("finish");
      jobsOf = async (itemId) => (await db.printJob.findMany({ where: { organizationId: org.org.id }, orderBy: { createdAt: "asc" } })).filter((j) => (j.items as { id: string }[]).some((i) => i.id === itemId));
    });

    it("with no primary printer the book is still finished and the label waits in the queue (not lost, not failed)", async () => {
      const b = await book("בלי מדפסת");
      const r = await finishCapture(org.photographer, b.id, { status: "COMPLETED", opId: randomUUID() });
      expect(r.changed).toBe(true);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: b.id } })).photoStatus).toBe("COMPLETED");
      expect("jobId" in r.print).toBe(true);
      const [job] = await jobsOf(b.id);
      expect(job!.status).toBe("PENDING");
      expect(job!.printerId).toBeNull();
      const d = await describePrintJob(org.org.id, { ...job!, attempts: 0, error: null, sentAt: null, doneAt: null, labelCount: 1 });
      expect(d.waiting).toBe("NO_PRINTER");

      // an agent that polls does not take it (it would fail without a printer) ...
      agent = await pairAgent(org.admin, "PRINT", "print-pc");
      expect(await claimNextPrintJob(agent)).toBeNull();
      expect((await db.printJob.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("PENDING");
      // ... and prints it once a primary printer exists
      printerId = (await createPrinter(org.admin, { name: "Zebra", connection: "NETWORK", host: "192.168.1.50", port: 9100, labelSize: "57x32", dotsPerMm: 8 })).id;
      const claimed = await claimNextPrintJob(agent);
      expect(claimed?.jobId).toBe(job!.id);
      expect(claimed?.zpl ?? claimed?.labels).toBeTruthy();
      await reportPrintJob(agent, job!.id, { status: "DONE" });
    });

    it("one finish = one label for the physical book; a double click / retried request / lost response never queues a second", async () => {
      const b = await book("סיום כפול");
      const opId = randomUUID();
      const results = await Promise.all(Array.from({ length: 5 }, () => finishCapture(org.photographer, b.id, { status: "COMPLETED", opId })));
      const ids = new Set(results.map((r) => ("jobId" in r.print ? r.print.jobId : "err")));
      expect(ids.size).toBe(1);
      expect(await jobsOf(b.id)).toHaveLength(1);
      await finishCapture(org.photographer, b.id, { status: "COMPLETED", opId }); // retry after a timeout, later
      expect(await jobsOf(b.id)).toHaveLength(1);
      const [job] = await jobsOf(b.id);
      expect(job!.printerId).toBe(printerId);
      expect(await db.printJob.findUniqueOrThrow({ where: { id: job!.id } })).toMatchObject({ kind: "BOOK", labelCount: 1, copies: 1 });
      expect((await db.printJob.findUniqueOrThrow({ where: { id: job!.id } })).items).toEqual([{ type: "BOOK", id: b.id }]);
    });

    it("finishing a book from its catalog lot labels the physical book (InventoryItem), not the lot", async () => {
      const cat = await createCatalog(org.editor, { auctionHouseId: org.house.id, number: "F1", name: "סיום" });
      const lot = await createLot(org.photographer, cat.id, { title: "מהקטלוג", consignorId: (await createConsignor(org.editor, { name: "מפקיד קטלוג" })).id });
      const r = await finishCapture(org.photographer, lot.id, { status: "PENDING_REVIEW", opId: randomUUID() });
      expect(r.itemId).toBe(lot.inventoryItemId);
      const jobs = await jobsOf(lot.inventoryItemId);
      expect(jobs).toHaveLength(1);
      expect((await db.printJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).items).toEqual([{ type: "BOOK", id: lot.inventoryItemId }]);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe("PENDING_REVIEW");
    });

    it("a printing problem never blocks the finish: the status is saved and the error is reported", async () => {
      const b = await book("מחיקה ממתינה");
      await db.inventoryItem.update({ where: { id: b.id }, data: { deletionRequestedAt: new Date() } });
      const r = await finishCapture(org.photographer, b.id, { status: "COMPLETED", opId: randomUUID() });
      expect(r.changed).toBe(true);
      expect("error" in r.print).toBe(true);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: b.id } })).photoStatus).toBe("COMPLETED");
      expect(await jobsOf(b.id)).toHaveLength(0);
    });

    it("the label is queued only by finishing: a manual status change, an edit or a reshoot request print nothing", async () => {
      const b = await book("שינוי ידני");
      await setItemPhotoStatus(org.editor, b.id, "COMPLETED");
      await updateItem(org.editor, b.id, { author: "מחבר חדש" });
      await setItemPhotoStatus(org.editor, b.id, "IN_PROGRESS");
      expect(await jobsOf(b.id)).toHaveLength(0);
    });

    it("job status is reported honestly: queued is not printed", async () => {
      // the queue is FIFO: finish what the earlier tests left so this test sees its own job first
      for (let i = 0; i < 20; i++) {
        const c = await claimNextPrintJob(agent);
        if (!c) break;
        await reportPrintJob(agent, c.jobId, { status: "DONE" });
      }
      const b = await book("סטטוס אמיתי");
      const r = await finishCapture(org.photographer, b.id, { status: "COMPLETED", opId: randomUUID() });
      const jobId = "jobId" in r.print ? r.print.jobId : "";
      const row = () => db.printJob.findUniqueOrThrow({ where: { id: jobId } });
      let d = await describePrintJob(org.org.id, { ...(await row()), attempts: 0, labelCount: 1 });
      expect(d.status).toBe("PENDING");
      expect(d.waiting).not.toBe("NO_PRINTER");
      const claimed = await claimNextPrintJob(agent);
      expect(claimed?.jobId).toBe(jobId);
      await reportPrintJob(agent, jobId, { status: "SENT" });
      d = await describePrintJob(org.org.id, await row());
      expect(d.status).toBe("SENT"); // not "printed"
      await reportPrintJob(agent, jobId, { status: "DONE" });
      d = await describePrintJob(org.org.id, await row());
      expect(d.status).toBe("DONE");
    });

    it("another organization cannot finish (or label) this book", async () => {
      const b = await book("זר");
      await expect(finishCapture(other.photographer, b.id, { status: "COMPLETED", opId: randomUUID() })).rejects.toThrow(/לא נמצא/);
    });
  });
});
