import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { can } from "@/server/auth/permissions";
import { storage, keys } from "@/server/storage";
import { createCatalog } from "@/server/services/catalogs";
import { assignToCatalog, setLotCommercialStatus } from "@/server/services/assignments";
import { createLot, deleteLot, listLots, moveLotToCatalog, updateLot } from "@/server/services/lots";
import { createConsignor } from "@/server/services/consignors";
import { createItem, updateItem } from "@/server/services/inventory";
import { healLotNumbers, DIFFERENT_CONSIGNORS_MESSAGE, addBooksToLot, dissolveLot, lotCandidates, mergeLots, removeBookFromLot, reorderLotMembers } from "@/server/services/lot-members";
import { listCombinedLotAssets, reorderLotGallery, setLotAssetHidden, setPrimary } from "@/server/services/assets";
import { lotFulfilment, markPacked, markShipped, pickItemTx } from "@/server/services/picking";
import { applyLotAiRun, discardLotAiRun, generateLotDescription, getLotAiState } from "@/server/services/lot-ai";
import { runExportJob, lotsCsv } from "@/server/services/exports";
import { removeLotsFromCatalog } from "@/server/services/deletion";
import { recountItem } from "@/server/services/lot-counters";
import { changeStatus } from "@/server/services/item-status";
import { globalSearch } from "@/server/services/search";
import { setProviderOverride } from "@/server/ai/providers";
import type { AiProvider, ProviderRequest, ProviderResponse } from "@/server/ai/providers/types";
import { hasForbiddenDash } from "@/server/ai/text";
import { createCustomer } from "@/server/services/customers";
import { recordSale, releasePurchase } from "@/server/services/sales";
import { hasDb, makeOrg } from "./helpers";

/* A fake provider: records every request, never touches the network. */
class FakeProvider implements AiProvider {
  readonly name = "openai" as const;
  readonly model = "gpt-5.4-mini";
  requests: ProviderRequest[] = [];
  answer: (req: ProviderRequest) => unknown = () => lotAnswer();
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    const body = this.answer(req);
    return { text: typeof body === "string" ? body : ser(body), usage: { inputTokens: 4000, cachedInputTokens: 1000, outputTokens: 900, reasoningTokens: 100, extraReasoningTokens: 0 }, model: "gpt-5.4-mini-2026-03-17", requestId: `req-${this.requests.length}`, finish: "completed" };
  }
}
const lotAnswer = (over: Record<string, unknown> = {}) => ({
  title: "שלושה ספרי חידושים — אוסף משותף",
  shortDescription: "שלושה ספרים מאותו מפקיד.",
  description: "אוסף של ספרים — עותקים שונים.\n\nספר ראשון: חידושי תורה. מצב טוב.\n\nספר שני: שו\"ת. כתמים.",
  sharedSignificance: { status: "none", note: null },
  mainFeature: { text: null, bookId: null, verified: false },
  unverifiedInfoUsed: true,
  warnings: ["אין מידע על מצב הספר השלישי"],
  ...over,
});

const ser = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const names = (zip: Buffer) => {
  const out: string[] = [];
  for (let i = 0; i < zip.length - 46; i++) {
    if (zip.readUInt32LE(i) === 0x02014b50) {
      const n = zip.readUInt16LE(i + 28);
      const e = zip.readUInt16LE(i + 30);
      const c = zip.readUInt16LE(i + 32);
      out.push(zip.subarray(i + 46, i + 46 + n).toString("utf8"));
      i += 45 + n + e + c;
    }
  }
  return out;
};

describe.skipIf(!hasDb)("combined lots (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let other: Awaited<ReturnType<typeof makeOrg>>;
  let anna: { id: string };
  let boaz: { id: string };
  const fake = new FakeProvider();
  const savedEnv = { ...process.env };
  let seq = 0;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "sk-it-not-used";
    process.env.BOOK_AI_PROVIDER = "openai";
    setProviderOverride(fake);
    ctx = await makeOrg("combo");
    other = await makeOrg("combo-other");
    anna = await createConsignor(ctx.editor, { name: "אנה" });
    boaz = await createConsignor(ctx.editor, { name: "בועז" });
  });
  afterAll(() => {
    setProviderOverride(null);
    process.env = savedEnv;
  });

  /** a fresh catalog + `n` single-book lots (consignor Anna unless given), numbered 1..n */
  async function setup(n: number, consignors: ({ id: string } | null)[] = []) {
    const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `C${++seq}-${Date.now() % 100000}`, name: "קטלוג בדיקה" });
    const lots = [];
    for (let i = 0; i < n; i++) {
      const cons = consignors[i] === undefined ? anna : consignors[i];
      const { item } = await createItem(ctx.editor, { title: `ספר ${i + 1}`, consignorId: cons?.id } as never);
      const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: catalog.id });
      lots.push({ lot, item });
    }
    return { catalog, lots };
  }

  async function photo(itemId: string, category: "COVER" | "TITLE_PAGE" | "INTERIOR", n = 1) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const bytes = Buffer.from(`jpeg-${id}`);
      const last = await db.photoAsset.aggregate({ where: { inventoryItemId: itemId }, _max: { sequence: true, sortOrder: true } });
      await db.photoAsset.create({
        data: {
          id,
          organizationId: ctx.org.id,
          inventoryItemId: itemId,
          category: category as never,
          captureId: randomUUID(),
          source: "SIMULATOR" as never,
          sequence: (last._max.sequence ?? 0) + 1,
          sortOrder: (last._max.sortOrder ?? 0) + 1,
          capturedAt: new Date(),
          width: 100,
          height: 100,
        },
      });
      const key = keys.original(ctx.org.id, id, "PRIMARY", "jpg");
      await storage().putBuffer(key, bytes, "image/jpeg");
      await db.photoFile.create({ data: { assetId: id, role: "PRIMARY", originalFilename: `${id}.jpg`, mimeType: "image/jpeg", extension: "jpg", sizeBytes: BigInt(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadStatus: "VERIFIED" } });
      ids.push(id);
    }
    await db.$transaction((tx) => recountItem(tx, itemId));
    return ids;
  }

  /** a sale no longer creates pick tasks by itself: a buyer is recorded and the sale is released to picking (by an admin: unpaid release) */
  let buyerSeq = 0;
  async function releaseSold(lotId: string) {
    const c = await createCustomer(ctx.editor, { name: `קונה ${++buyerSeq}`, email: `rel${buyerSeq}-${Date.now()}@example.com` });
    const p = await recordSale(ctx.editor, { lotId, customerId: c.id, hammerPrice: "100" });
    await releasePurchase(ctx.admin, p.id);
    return p;
  }
  const approveAll = (lots: { item: { id: string } }[]) => db.inventoryItem.updateMany({ where: { id: { in: lots.map((l) => l.item.id) } }, data: { reviewStatus: "APPROVED" } });
  const members = (lotId: string) => db.lotMember.findMany({ where: { lotId, removedAt: null }, orderBy: { sortOrder: "asc" } });
  const merge = (catalogId: string, lots: { lot: { id: string } }[], keep = 0) => mergeLots(ctx.editor, { catalogId, lotIds: lots.map((l) => l.lot.id), keepLotId: lots[keep]!.lot.id });

  /* ─────────────────────────── merge ─────────────────────────── */

  describe("merge", () => {
    it("two books of one consignor become one lot; the kept number stays, the other lot ends as history and its number is never reused", async () => {
      const { catalog, lots } = await setup(3);
      const [a, b, c] = lots as [(typeof lots)[number], (typeof lots)[number], (typeof lots)[number]];
      const r = await merge(catalog.id, [a, b]);
      expect(r.lotNumber).toBe(1); // the kept lot is the first one: its number is unchanged
      expect(r.itemIds).toEqual([a.item.id, b.item.id]);
      expect(r.absorbed).toEqual([b.lot.lotNumber]);

      const kept = await db.lot.findUniqueOrThrow({ where: { id: a.lot.id } });
      expect(kept.assignmentStatus).toBe("ACTIVE");
      expect(kept.compositionVersion).toBe(2);
      const ended = await db.lot.findUniqueOrThrow({ where: { id: b.lot.id } });
      expect(ended.assignmentStatus).toBe("ENDED");
      expect(ended.mergedIntoLotId).toBe(a.lot.id);
      expect(ended.lotNumber).toBeLessThan(0); // history leaves the visible numbering
      // the untouched lot keeps its number; no renumbering, no recycling
      // the numbers close up: no gap where the merged lot was
      expect((await db.lot.findUniqueOrThrow({ where: { id: c.lot.id } })).lotNumber).toBe(2);
      expect(await db.lot.count({ where: { catalogId: catalog.id } })).toBe(3);

      // the catalog shows the merged lot as ONE row
      const rows = await listLots(ctx.editor, catalog.id);
      expect(rows.map((x) => x.lotNumber)).toEqual([1, 2]);
      expect(rows[0]!.bookCount).toBe(2);
      expect(rows[0]!.books.map((x) => x.itemId)).toEqual([a.item.id, b.item.id]);
      expect(rows[1]!.bookCount).toBe(1);

      // a composition event and audit entries stay
      expect(await db.lotCompositionEvent.count({ where: { lotId: a.lot.id, kind: "MERGE" } })).toBe(1);
      expect(await db.auditLog.count({ where: { lotId: a.lot.id, action: "lot.merged" } })).toBe(1);
      expect(await db.auditLog.count({ where: { inventoryItemId: b.item.id, action: "lot.joined" } })).toBe(1);
    });

    it("keeps the lot number the user chose among the selected lots (not necessarily the lowest)", async () => {
      const { catalog, lots } = await setup(3);
      const r = await merge(catalog.id, lots, 2);
      expect(r.lotNumber).toBe(1); // the only visible lot of the catalog now
      expect(r.itemIds).toEqual(lots.map((l) => l.item.id)); // books keep the order of their lot numbers
      const ended = await db.lot.findMany({ where: { catalogId: catalog.id, mergedIntoLotId: lots[2]!.lot.id }, orderBy: { lotNumber: "asc" } });
      expect(ended.every((l) => l.lotNumber < 0)).toBe(true);
      expect(ended).toHaveLength(2);
      // a shared title can be set at merge time
      const { catalog: c2, lots: l2 } = await setup(2);
      await mergeLots(ctx.editor, { catalogId: c2.id, lotIds: l2.map((x) => x.lot.id), keepLotId: l2[0]!.lot.id, title: "אוסף מיוחד" });
      expect((await db.lot.findUniqueOrThrow({ where: { id: l2[0]!.lot.id } })).title).toBe("אוסף מיוחד");
      expect(await db.lotDescriptionVersion.count({ where: { lotId: l2[0]!.lot.id } })).toBe(2);
    });

    it("five books of one consignor in one lot", async () => {
      const { catalog, lots } = await setup(5);
      const r = await merge(catalog.id, lots);
      expect(r.itemIds).toHaveLength(5);
      const ms = await members(lots[0]!.lot.id);
      expect(ms.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4, 5]);
      expect(ms.every((m) => m.isActive)).toBe(true);
      expect(await db.lot.count({ where: { catalogId: catalog.id, assignmentStatus: "ACTIVE" } })).toBe(1);
    });

    it("different consignors are refused with the exact message, nothing changes", async () => {
      const { catalog, lots } = await setup(2, [anna, boaz]);
      await expect(merge(catalog.id, lots)).rejects.toMatchObject({ code: "CONFLICT", message: DIFFERENT_CONSIGNORS_MESSAGE });
      expect(DIFFERENT_CONSIGNORS_MESSAGE).toBe("לא ניתן לאחד ספרים ממפקידים שונים. כל הספרים בלוט משולב חייבים להשתייך לאותו מפקיד.");
      expect(await db.lot.count({ where: { catalogId: catalog.id, assignmentStatus: "ACTIVE" } })).toBe(2);
      expect(await db.lotMember.count({ where: { lotId: { in: lots.map((l) => l.lot.id) }, removedAt: null } })).toBe(2);
    });

    it("a book without a consignor (old data) cannot be merged", async () => {
      const { catalog, lots } = await setup(2);
      await db.inventoryItem.update({ where: { id: lots[1]!.item.id }, data: { consignorId: null } });
      await expect(merge(catalog.id, lots)).rejects.toThrow(/לא מוגדר מפקיד/);
    });

    it("lots of different catalogs are refused", async () => {
      const a = await setup(1);
      const b = await setup(1);
      await expect(mergeLots(ctx.editor, { catalogId: a.catalog.id, lotIds: [a.lots[0]!.lot.id, b.lots[0]!.lot.id], keepLotId: a.lots[0]!.lot.id })).rejects.toThrow(/קטלוגים שונים/);
    });

    it("a sold book, a book being picked, an offered lot and an archived catalog are refused", async () => {
      const { catalog, lots } = await setup(4);
      await setLotCommercialStatus(ctx.editor, lots[0]!.lot.id, { status: "SOLD" }); // creates a pick task
      await expect(merge(catalog.id, [lots[0]!, lots[1]!], 1)).rejects.toThrow(/נמכר|הוצע|השיוך/);
      await setLotCommercialStatus(ctx.editor, lots[2]!.lot.id, { status: "OFFERED" });
      await expect(merge(catalog.id, [lots[2]!, lots[3]!])).rejects.toThrow(/הוצע/);
      // an item with an open pick task that is somehow still assigned
      const { catalog: c2, lots: l2 } = await setup(2);
      await db.pickTask.create({ data: { organizationId: ctx.org.id, inventoryItemId: l2[1]!.item.id, reason: "ידני" } });
      await expect(merge(c2.id, l2)).rejects.toThrow(/ליקוט/);
      // shipped
      const { catalog: c3, lots: l3 } = await setup(2);
      await db.inventoryItem.update({ where: { id: l3[1]!.item.id }, data: { physicalStatus: "SHIPPED" } });
      await expect(merge(c3.id, l3)).rejects.toThrow(/נמכר או נשלח/);
      // archived
      const { catalog: c4, lots: l4 } = await setup(2);
      await db.catalog.update({ where: { id: c4.id }, data: { status: "ARCHIVED" } });
      await expect(merge(c4.id, l4)).rejects.toThrow(/ארכיון/);
    });

    it("a book that is already in another combined lot is refused (merge and add)", async () => {
      const { catalog, lots } = await setup(4);
      await merge(catalog.id, [lots[0]!, lots[1]!]);
      // the combined lot cannot be merged again through the table…
      await expect(merge(catalog.id, [lots[0]!, lots[2]!])).rejects.toThrow(/משולב/);
      // …and its book cannot be pulled into another lot by adding it there (it is not a single-book lot)
      await expect(addBooksToLot(ctx.editor, lots[2]!.lot.id, { lotIds: [lots[0]!.lot.id] })).rejects.toThrow(/משולב/);
      // the ended lot of a merged book cannot be merged again
      await expect(merge(catalog.id, [lots[1]!, lots[3]!])).rejects.toThrow(/אוחד|השיוך/);
      // an unassigned-book add of a book that sits in an active lot
      await expect(addBooksToLot(ctx.editor, lots[2]!.lot.id, { itemIds: [lots[1]!.item.id] })).rejects.toThrow(/כבר משויך/);
    });

    it("the original inventory data is untouched: numbers, barcodes, consignor, titles, status of AI, baselines, analyses, photo owners", async () => {
      const { catalog, lots } = await setup(3);
      await db.inventoryItem.update({ where: { id: lots[1]!.item.id }, data: { aiStatus: "COMPLETED", aiCompletedAt: new Date(), originalBaseline: { title: "x" }, reviewStatus: "APPROVED", detailsVersion: 7 } });
      await db.inventoryAnalysis.create({ data: { organizationId: ctx.org.id, inventoryItemId: lots[1]!.item.id, kind: "catalog_ai", status: "COMPLETED", result: { catalog: { headline: "h" } } } });
      const photos = await photo(lots[1]!.item.id, "COVER", 2);
      const snap = async () =>
        ser({
          items: await db.inventoryItem.findMany({ where: { id: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } }),
          analyses: await db.inventoryAnalysis.findMany({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } }),
          assets: (await db.photoAsset.findMany({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } })).map((a) => ({ id: a.id, owner: a.inventoryItemId, sort: a.sortOrder })),
        });
      const before = JSON.parse(await snap());
      await merge(catalog.id, lots);
      const after = JSON.parse(await snap());
      // only derived columns may differ (commercial status stays ASSIGNED, so even those are equal) and updatedAt
      const strip = (s: { items: Record<string, unknown>[] }) => s.items.map(({ updatedAt: _u, ...rest }) => rest);
      expect(strip(after)).toEqual(strip(before));
      expect(after.analyses).toEqual(before.analyses);
      expect(after.assets).toEqual(before.assets);
      expect(await db.inventoryItem.count({ where: { organizationId: ctx.org.id } })).toBeGreaterThanOrEqual(3); // nothing duplicated or deleted
      expect(photos).toHaveLength(2);
    });

    it("two parallel merges that share a book: exactly one wins, no book ends up in two active lots", async () => {
      const { catalog, lots } = await setup(3);
      const results = await Promise.allSettled([merge(catalog.id, [lots[0]!, lots[1]!]), merge(catalog.id, [lots[1]!, lots[2]!])]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const active = await db.lotMember.findMany({ where: { lotId: { in: lots.map((l) => l.lot.id) }, isActive: true, removedAt: null } });
      expect(new Set(active.map((m) => m.inventoryItemId)).size).toBe(active.length);
      // the database itself refuses a second active membership of one book
      const dup = active[0]!;
      await expect(db.lotMember.create({ data: { organizationId: ctx.org.id, lotId: lots.find((l) => l.lot.id !== dup.lotId)!.lot.id, inventoryItemId: dup.inventoryItemId, sortOrder: 9 } })).rejects.toThrow();
    });

    it("permissions and organization isolation", async () => {
      const { catalog, lots } = await setup(2);
      expect(can("PHOTOGRAPHER", "catalog.assign")).toBe(false);
      expect(can("EDITOR", "catalog.assign")).toBe(true);
      await expect(mergeLots(other.admin, { catalogId: catalog.id, lotIds: lots.map((l) => l.lot.id), keepLotId: lots[0]!.lot.id })).rejects.toThrow(/לא נמצא/);
      // house access is checked too
      const restricted = { ...ctx.editor, houseIds: [ctx.house2.id] } as typeof ctx.editor;
      await expect(mergeLots(restricted, { catalogId: catalog.id, lotIds: lots.map((l) => l.lot.id), keepLotId: lots[0]!.lot.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await db.lot.count({ where: { catalogId: catalog.id, assignmentStatus: "ACTIVE" } })).toBe(2);
    });
  });

  /* ─────────────────────────── gallery & export ─────────────────────────── */

  describe("shared gallery and export", () => {
    it("shows every book's photos, with their book; order, primary and hiding are lot presentation only", async () => {
      const { catalog, lots } = await setup(3);
      const pa = await photo(lots[0]!.item.id, "COVER", 2);
      const pb = await photo(lots[1]!.item.id, "TITLE_PAGE", 1);
      const pc = await photo(lots[2]!.item.id, "COVER", 1);
      await merge(catalog.id, lots);
      const lot = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      const g = await listCombinedLotAssets(ctx.org.id, lot);
      expect(g.map((a) => a.id)).toEqual([...pa, ...pb, ...pc]);
      expect(g.map((a) => a.book!.index)).toEqual([1, 1, 2, 3]);
      expect(g.every((a) => a.book!.inventoryNumber)).toBe(true);
      // filter by book
      expect((await listCombinedLotAssets(ctx.org.id, lot, { itemId: lots[1]!.item.id })).map((a) => a.id)).toEqual(pb);
      // the lot's photo count sums the books
      expect(lot.photoCount).toBe(4);
      await db.$transaction((tx) => recountItem(tx, lots[0]!.item.id));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).photoCount).toBe(4);

      // lot primary: a photo of another book
      await setPrimary(ctx.editor, pc[0]!, lot.id);
      expect((await listCombinedLotAssets(ctx.org.id, await db.lot.findUniqueOrThrow({ where: { id: lot.id } }))).find((a) => a.isPrimary)!.id).toBe(pc[0]);
      // a photo of a book outside the lot cannot be the lot's primary
      const stranger = await createItem(ctx.editor, { title: "זר", consignorId: anna.id } as never);
      const [sp] = await photo(stranger.item.id, "COVER", 1);
      await expect(setPrimary(ctx.editor, sp!, lot.id)).rejects.toThrow(/אינה של ספר בלוט/);

      // order: reverse. The books' own photo order is not touched.
      const masterBefore = (await db.photoAsset.findMany({ where: { inventoryItemId: lots[0]!.item.id }, orderBy: { sortOrder: "asc" } })).map((a) => a.id);
      await reorderLotGallery(ctx.editor, lot.id, [pc[0]!, pb[0]!, pa[1]!, pa[0]!]);
      const fresh = await db.lot.findUniqueOrThrow({ where: { id: lot.id } });
      expect((await listCombinedLotAssets(ctx.org.id, fresh)).map((a) => a.id)).toEqual([pc[0], pb[0], pa[1], pa[0]]);
      expect((await db.photoAsset.findMany({ where: { inventoryItemId: lots[0]!.item.id }, orderBy: { sortOrder: "asc" } })).map((a) => a.id)).toEqual(masterBefore);
      // a stale order list is refused
      await expect(reorderLotGallery(ctx.editor, lot.id, [pc[0]!, pb[0]!])).rejects.toThrow(/השתנה/);

      // hide one photo from the catalog view: still owned by its book, flagged in the gallery, absent from the visible order
      await setLotAssetHidden(ctx.editor, lot.id, pb[0]!, true);
      const view = await listCombinedLotAssets(ctx.org.id, fresh);
      expect(view.find((a) => a.id === pb[0])!.hidden).toBe(true);
      expect((await db.photoAsset.findUniqueOrThrow({ where: { id: pb[0]! } })).inventoryItemId).toBe(lots[1]!.item.id);
    });

    it("the ZIP export of a combined lot has the photos of ALL books in the chosen order, hidden ones left out; the catalog CSV has one row", async () => {
      const { catalog, lots } = await setup(2);
      const pa = await photo(lots[0]!.item.id, "COVER", 2);
      const pb = await photo(lots[1]!.item.id, "COVER", 2);
      await merge(catalog.id, lots);
      const lot = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      await reorderLotGallery(ctx.editor, lot.id, [pb[0]!, pa[0]!, pa[1]!, pb[1]!]);
      await setLotAssetHidden(ctx.editor, lot.id, pa[1]!, true);

      const job = await db.job.create({ data: { organizationId: ctx.org.id, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "lot", lotId: lot.id, catalogId: catalog.id, variant: "original", includeRaw: true, maxSize: 3000, readableFolders: false } } });
      await runExportJob(job);
      const zip = await storage().getBuffer((await db.job.findUniqueOrThrow({ where: { id: job.id } })).resultKey!);
      const photosInZip = names(zip).filter((n) => n.endsWith(".jpg"));
      expect(photosInZip).toHaveLength(3);
      // numbered 001..003 in the lot's order, each named by its book
      expect(photosInZip.map((n) => n.split("/").pop()!.split("-")[1])).toEqual(["001", "002", "003"]);
      expect(photosInZip[0]).toContain(lots[1]!.item.inventoryNumber);
      expect(photosInZip[1]).toContain(lots[0]!.item.inventoryNumber);
      expect(photosInZip[2]).toContain(lots[1]!.item.inventoryNumber);
      const manifest = names(zip).find((n) => n.endsWith("manifest.csv"))!;
      expect(manifest).toBeTruthy();

      // a catalog-wide export includes the combined lot once, and the CSV lists ONE row with the lot number
      const jobC = await db.job.create({ data: { organizationId: ctx.org.id, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "catalog", catalogId: catalog.id, variant: "original", includeRaw: true, maxSize: 3000, readableFolders: false } } });
      await runExportJob(jobC);
      const zipC = names(await storage().getBuffer((await db.job.findUniqueOrThrow({ where: { id: jobC.id } })).resultKey!)).filter((n) => n.endsWith(".jpg"));
      expect(zipC).toHaveLength(3);
      const csv = (await lotsCsv(ctx.org.id, catalog.id)).body.split("\r\n").filter(Boolean);
      expect(csv).toHaveLength(2); // header + ONE lot
      expect(csv[1]).toContain(`${lot.lotNumber},`);
      expect(csv[1]).toContain(lots[0]!.item.inventoryNumber);
      expect(csv[1]).toContain(lots[1]!.item.inventoryNumber);

      // a selection of photos of both books exports as the combined lot too
      const jobS = await db.job.create({ data: { organizationId: ctx.org.id, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "selection", assetIds: [pa[0]!, pb[0]!], variant: "original", includeRaw: true, maxSize: 3000, readableFolders: false } } });
      await runExportJob(jobS);
      expect(names(await storage().getBuffer((await db.job.findUniqueOrThrow({ where: { id: jobS.id } })).resultKey!)).filter((n) => n.endsWith(".jpg"))).toHaveLength(2);
    });

    it("an ordinary single-book lot exports exactly as before (category folders, per-category numbering)", async () => {
      const { catalog, lots } = await setup(1);
      await photo(lots[0]!.item.id, "COVER", 2);
      const job = await db.job.create({ data: { organizationId: ctx.org.id, type: "EXPORT_ZIP", status: "RUNNING", payload: { scope: "lot", lotId: lots[0]!.lot.id, catalogId: catalog.id, variant: "original", includeRaw: true, maxSize: 3000, readableFolders: false } } });
      await runExportJob(job);
      const files = names(await storage().getBuffer((await db.job.findUniqueOrThrow({ where: { id: job.id } })).resultKey!)).filter((n) => n.endsWith(".jpg"));
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/Lot-\d+\/cover\/L\d+-cover-001\.jpg$/);
    });
  });

  /* ─────────────────────────── add / remove / dissolve ─────────────────────────── */

  describe("changing the composition", () => {
    it("remove: the book returns to its own lot with its historical number; the lot with one book left behaves as an ordinary lot", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, [lots[0]!, lots[1]!]);
      const r = await removeBookFromLot(ctx.editor, lots[0]!.lot.id, lots[1]!.item.id);
      expect(r.newLot.lotId).toBe(lots[1]!.lot.id);
      expect(r.newLot.restored).toBe(true);
      expect(r.remaining).toBe(1);
      const back = await db.lot.findUniqueOrThrow({ where: { id: lots[1]!.lot.id } });
      expect(back.assignmentStatus).toBe("ACTIVE");
      expect(back.mergedIntoLotId).toBeNull();
      expect(back.lotNumber).toBe(3); // joins the end of the catalog
      expect((await members(back.id)).map((m) => m.inventoryItemId)).toEqual([lots[1]!.item.id]);
      expect((await members(lots[0]!.lot.id)).map((m) => m.inventoryItemId)).toEqual([lots[0]!.item.id]);
      // history rows stay
      expect(await db.lotMember.count({ where: { lotId: lots[0]!.lot.id, inventoryItemId: lots[1]!.item.id, removedAt: { not: null } } })).toBe(1);
      expect(await db.lotCompositionEvent.count({ where: { lotId: lots[0]!.lot.id, kind: "REMOVE" } })).toBe(1);
      // the last book of a lot cannot be "removed"
      await expect(removeBookFromLot(ctx.editor, lots[0]!.lot.id, lots[0]!.item.id)).rejects.toThrow(/הספר היחיד/);
      expect((await listLots(ctx.editor, catalog.id)).map((x) => x.lotNumber)).toEqual([1, 2, 3]);
    });

    it("removing the lot's own (first) book gives that book a NEW number: the combined lot keeps its number", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      const r = await removeBookFromLot(ctx.editor, lots[0]!.lot.id, lots[0]!.item.id);
      expect(r.newLot.restored).toBe(false);
      const fresh = await db.lot.findUniqueOrThrow({ where: { id: r.newLot.lotId } });
      expect(fresh.lotNumber).toBe(2); // the next number after the combined lot (1): no gaps
      const kept = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      expect(kept.inventoryItemId).not.toBe(lots[0]!.item.id); // the anchor moved to a present book
      expect((await members(kept.id)).map((m) => m.inventoryItemId)).toEqual([lots[1]!.item.id, lots[2]!.item.id]);
      // the removed book's lot is an ordinary active lot
      expect((await members(fresh.id)).map((m) => m.inventoryItemId)).toEqual([lots[0]!.item.id]);
      const active = await db.lotMember.findMany({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) }, isActive: true, removedAt: null } });
      expect(active).toHaveLength(3);
    });

    it("add: same-catalog single lots of the same consignor and unassigned books join; others are not offered or refused", async () => {
      const { catalog, lots } = await setup(4, [anna, anna, boaz, anna]);
      await merge(catalog.id, [lots[0]!, lots[1]!]);
      const loose = await createItem(ctx.editor, { title: "ספר ללא קטלוג", consignorId: anna.id } as never);
      const stranger = await createItem(ctx.editor, { title: "ספר של בועז", consignorId: boaz.id } as never);
      const cand = await lotCandidates(ctx.editor, lots[0]!.lot.id);
      expect(cand.consignorId).toBe(anna.id);
      expect(cand.lots.map((l) => l.lotId)).toEqual([lots[3]!.lot.id]); // not Boaz's lot, not the merged-away lot
      expect(cand.items.map((i) => i.id)).toContain(loose.item.id);
      expect(cand.items.map((i) => i.id)).not.toContain(stranger.item.id);

      await expect(addBooksToLot(ctx.editor, lots[0]!.lot.id, { lotIds: [lots[2]!.lot.id] })).rejects.toMatchObject({ message: DIFFERENT_CONSIGNORS_MESSAGE });
      await expect(addBooksToLot(ctx.editor, lots[0]!.lot.id, { itemIds: [stranger.item.id] })).rejects.toMatchObject({ message: DIFFERENT_CONSIGNORS_MESSAGE });

      await addBooksToLot(ctx.editor, lots[0]!.lot.id, { lotIds: [lots[3]!.lot.id], itemIds: [loose.item.id] });
      expect((await members(lots[0]!.lot.id)).map((m) => m.inventoryItemId)).toEqual([lots[0]!.item.id, lots[1]!.item.id, lots[3]!.item.id, loose.item.id]);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[3]!.lot.id } })).mergedIntoLotId).toBe(lots[0]!.lot.id);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: loose.item.id } })).commercialStatus).toBe("ASSIGNED");

      // removing the unassigned book gives it a new lot of its own
      const r = await removeBookFromLot(ctx.editor, lots[0]!.lot.id, loose.item.id);
      expect(r.newLot.restored).toBe(false);
      expect(await db.lot.findUniqueOrThrow({ where: { id: r.newLot.lotId } })).toMatchObject({ catalogId: catalog.id, assignmentStatus: "ACTIVE" });
    });

    it("the order of the books can be changed, a stale list is refused", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      const ids = lots.map((l) => l.item.id);
      await reorderLotMembers(ctx.editor, lots[0]!.lot.id, [ids[2]!, ids[0]!, ids[1]!]);
      expect((await members(lots[0]!.lot.id)).map((m) => m.inventoryItemId)).toEqual([ids[2], ids[0], ids[1]]);
      await expect(reorderLotMembers(ctx.editor, lots[0]!.lot.id, [ids[0]!, ids[1]!])).rejects.toThrow(/השתנתה/);
    });

    it("dissolve: every book returns to a separate lot in the same catalog, photos and AI data untouched, shared text kept in the history", async () => {
      const { catalog, lots } = await setup(3);
      await db.inventoryItem.update({ where: { id: lots[1]!.item.id }, data: { aiStatus: "COMPLETED", detailsVersion: 3 } });
      const pa = await photo(lots[1]!.item.id, "COVER", 1);
      await merge(catalog.id, lots);
      await updateLot(ctx.editor, lots[0]!.lot.id, { title: "כותרת משותפת", description: "תיאור משותף של שלושה ספרים" });
      const itemsBefore = ser((await db.inventoryItem.findMany({ where: { id: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } })).map(({ updatedAt: _u, ...x }) => x));

      const r = await dissolveLot(ctx.editor, lots[0]!.lot.id);
      expect(r.keptBy).toBe(lots[0]!.item.id);
      expect(r.placements.map((p) => p.lotId).sort()).toEqual([lots[1]!.lot.id, lots[2]!.lot.id].sort());
      for (const l of lots) {
        const m = await members(l.lot.id);
        expect(m.map((x) => x.inventoryItemId)).toEqual([l.item.id]);
        expect((await db.lot.findUniqueOrThrow({ where: { id: l.lot.id } })).assignmentStatus).toBe("ACTIVE");
        expect((await db.lot.findUniqueOrThrow({ where: { id: l.lot.id } })).lotNumber).toBe(l.lot.lotNumber);
      }
      // the first lot is back to the book's own presentation; the shared text stays in its version history
      const first = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      expect(first.title).toBe(lots[0]!.lot.title);
      expect(first.description).toBe(lots[0]!.lot.description);
      const versions = await db.lotDescriptionVersion.findMany({ where: { lotId: first.id }, orderBy: { version: "asc" } });
      expect(versions.some((v) => v.title === "כותרת משותפת" && v.description === "תיאור משותף של שלושה ספרים")).toBe(true);
      expect(await db.lotCompositionEvent.count({ where: { lotId: first.id, kind: "DISSOLVE" } })).toBe(1);
      expect(await db.lotCompositionEvent.count({ where: { lotId: first.id, kind: "MERGE" } })).toBe(1); // the merge itself is not erased
      expect(await db.lotMember.count({ where: { lotId: first.id } })).toBe(3); // the founding book + 2 absorbed books: the two closed rows stay as history
      expect(ser((await db.inventoryItem.findMany({ where: { id: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } })).map(({ updatedAt: _u, ...x }) => x))).toBe(itemsBefore);
      expect((await db.photoAsset.findUniqueOrThrow({ where: { id: pa[0]! } })).inventoryItemId).toBe(lots[1]!.item.id);
      expect((await listLots(ctx.editor, catalog.id)).map((x) => x.lotNumber)).toEqual(lots.map((l) => l.lot.lotNumber));
      await expect(dissolveLot(ctx.editor, first.id)).rejects.toThrow(/לא לוט משולב/);
    });

    it("no changes once the lot was offered or sold", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, [lots[0]!, lots[1]!]);
      await setLotCommercialStatus(ctx.editor, lots[0]!.lot.id, { status: "OFFERED" });
      await expect(removeBookFromLot(ctx.editor, lots[0]!.lot.id, lots[1]!.item.id)).rejects.toThrow(/הוצע/);
      await expect(dissolveLot(ctx.editor, lots[0]!.lot.id)).rejects.toThrow(/הוצע/);
      await expect(addBooksToLot(ctx.editor, lots[0]!.lot.id, { lotIds: [lots[2]!.lot.id] })).rejects.toThrow(/הוצע/);
      await setLotCommercialStatus(ctx.editor, lots[0]!.lot.id, { status: "SOLD" });
      await expect(dissolveLot(ctx.editor, lots[0]!.lot.id)).rejects.toThrow();
    });

    it("the consignor of one book of a combined lot cannot be changed", async () => {
      const { catalog, lots } = await setup(2);
      await merge(catalog.id, lots);
      await expect(updateItem(ctx.editor, lots[1]!.item.id, { consignorId: boaz.id } as never)).rejects.toThrow(/לוט משולב/);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[1]!.item.id } })).consignorId).toBe(anna.id);
      // an ordinary lot's book can change consignor as always
      const solo = await setup(1);
      await updateItem(ctx.editor, solo.lots[0]!.item.id, { consignorId: boaz.id } as never);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: solo.lots[0]!.item.id } })).consignorId).toBe(boaz.id);
    });

    it("a book of a combined lot cannot be edited into the lot's title, deleted, or removed from the catalog one by one; the lot can be moved to another catalog whole", async () => {
      const { catalog, lots } = await setup(2);
      await merge(catalog.id, lots);
      // book edit does not leak into the shared title
      await updateItem(ctx.editor, lots[0]!.item.id, { title: "שם חדש לספר" } as never);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).title).toBe(lots[0]!.lot.title);
      await expect(deleteLot(ctx.editor, lots[0]!.lot.id)).rejects.toThrow(/לוט משולב/);
      expect((await removeLotsFromCatalog(ctx.editor, catalog.id, [lots[0]!.lot.id])).failed).toHaveLength(1);
      expect((await removeLotsFromCatalog(ctx.editor, catalog.id, [lots[1]!.lot.id])).failed).toHaveLength(1); // merged-away history

      const target = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `T${++seq}-${Date.now() % 100000}`, name: "יעד" });
      const moved = await moveLotToCatalog(ctx.editor, lots[0]!.lot.id, target.id);
      expect(moved.catalogId).toBe(target.id);
      expect((await members(moved.id)).map((m) => m.inventoryItemId)).toEqual(lots.map((l) => l.item.id));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).assignmentStatus).toBe("ENDED");
      expect(await db.lotMember.count({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) }, isActive: true, removedAt: null } })).toBe(2);
    });

    it("search finds the combined lot by any of its books and does not list the merged-away lot", async () => {
      const { catalog, lots } = await setup(2);
      await db.inventoryItem.update({ where: { id: lots[1]!.item.id }, data: { title: "ייחודי-למחפש-xyz" } });
      await merge(catalog.id, lots);
      const r = await globalSearch(ctx.editor, "ייחודי-למחפש");
      expect(r.lots.map((l) => l.id)).toEqual([lots[0]!.lot.id]);
    });
  });

  /* ─────────────────────────── shared AI description ─────────────────────────── */

  describe("shared AI description", () => {
    it("is generated from the books, with separate ids and a verified flag, by the model of the AI settings; the preview changes nothing until applied", async () => {
      const { catalog, lots } = await setup(3);
      await db.inventoryItem.update({ where: { id: lots[0]!.item.id }, data: { reviewStatus: "APPROVED", author: "מחבר מאושר", conditionNotes: "מצב טוב", catalogDescription: "תיאור של ספר 1" } });
      await merge(catalog.id, lots);
      const lotBefore = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      fake.requests = [];
      fake.answer = () => lotAnswer();
      // only when EVERY book of the lot was reviewed and approved by a person
      await expect(generateLotDescription(ctx.editor, lots[0]!.lot.id)).rejects.toMatchObject({ details: { code: "BOOKS_NOT_APPROVED" } });
      expect(fake.requests).toHaveLength(0);
      expect((await getLotAiState(ctx.editor, lots[0]!.lot.id)).unapproved).toHaveLength(2);
      await approveAll(lots);
      expect((await getLotAiState(ctx.editor, lots[0]!.lot.id)).unapproved).toHaveLength(0);
      const run = await generateLotDescription(ctx.editor, lots[0]!.lot.id);
      expect(run.status).toBe("COMPLETED");
      expect(fake.requests).toHaveLength(1);
      const req = fake.requests[0]!;
      expect(req.images).toHaveLength(0); // first version: no re-analysis of photos
      expect(req.userText).toContain("מספר הספרים בלוט: 3");
      expect(req.userText).toContain('"bookId": "book-1"');
      expect(req.userText).toContain('"bookId": "book-3"');
      expect(req.userText).toContain("מחבר מאושר");
      const blocks = JSON.parse(req.userText.split("```json")[1]!.split("```")[0]!) as { bookId: string; verified: boolean }[];
      expect(blocks.map((b) => [b.bookId, b.verified])).toEqual([["book-1", true], ["book-2", true], ["book-3", true]]);
      expect(req.userText).not.toContain(lots[0]!.item.inventoryNumber); // nothing operational is sent
      expect(req.instructions).toContain("verified = false");
      expect(run.provider).toBe("openai");
      expect(run.model).toBe("gpt-5.4-mini");
      expect(run.promptVersion).toMatch(/^avot-lot-/);
      expect(run.inputTokens).toBe(4000);
      expect(run.costUsd).not.toBeNull();
      expect((run.members as { itemId: string }[]).map((m) => m.itemId)).toEqual(lots.map((l) => l.item.id));
      expect(hasForbiddenDash(run.proposedTitle!)).toBe(false); // the em dash of the answer was normalised
      expect(run.proposedTitle).toContain("-");

      // preview only: the lot is exactly as before
      const lotMid = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      expect({ t: lotMid.title, d: lotMid.description, s: lotMid.shortDescription }).toEqual({ t: lotBefore.title, d: lotBefore.description, s: lotBefore.shortDescription });
      const state = await getLotAiState(ctx.editor, lots[0]!.lot.id);
      expect(state.runs[0]!.id).toBe(run.id);
      expect(state.runs[0]!.stale).toBe(false);

      // applying: lot fields + a new description version (source AI), the older versions stay
      const versionsBefore = await db.lotDescriptionVersion.count({ where: { lotId: lotBefore.id } });
      const applied = await applyLotAiRun(ctx.editor, run.id, {});
      expect(applied.version).toBe(versionsBefore + 1);
      const lotAfter = await db.lot.findUniqueOrThrow({ where: { id: lotBefore.id } });
      expect(lotAfter.title).toBe(run.proposedTitle);
      expect(lotAfter.description).toBe(run.proposedDescription);
      expect(lotAfter.aiDescriptionRunId).toBe(run.id);
      expect(lotAfter.descriptionNeedsUpdate).toBe(false);
      const v = await db.lotDescriptionVersion.findFirstOrThrow({ where: { lotId: lotBefore.id, version: applied.version } });
      expect(v.source).toBe("AI");
      expect(await db.lotDescriptionVersion.count({ where: { lotId: lotBefore.id } })).toBe(versionsBefore + 1);
      await expect(applyLotAiRun(ctx.editor, run.id, {})).rejects.toThrow(/כבר הוחל/);
    });

    it("never changes any field or analysis of the books", async () => {
      const { catalog, lots } = await setup(3);
      await db.inventoryItem.update({ where: { id: lots[1]!.item.id }, data: { aiStatus: "COMPLETED", aiCompletedAt: new Date(), originalBaseline: { t: 1 }, originalBaselineAt: new Date(), reviewStatus: "APPROVED", detailsVersion: 4, catalogDescription: "תיאור ספר", catalogHeadline: "כותרת ספר" } });
      await db.inventoryAnalysis.create({ data: { organizationId: ctx.org.id, inventoryItemId: lots[1]!.item.id, kind: "catalog_ai", status: "COMPLETED", result: { findings: [{ kind: "signature", transcription: "חתימה", reading: "probable", attribution: null, significance: "x" }] } } });
      await merge(catalog.id, lots);
      await approveAll(lots);
      const snap = async () => ser({ items: (await db.inventoryItem.findMany({ where: { id: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } })).map(({ updatedAt: _u, ...x }) => x), analyses: await db.inventoryAnalysis.findMany({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) } }, orderBy: { id: "asc" } }), status: await db.inventoryStatusEvent.count({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) } } }) });
      const before = await snap();
      fake.requests = [];
      const run = await generateLotDescription(ctx.editor, lots[0]!.lot.id);
      expect(fake.requests[0]!.userText).toContain("חתימה"); // the findings reach the model
      await applyLotAiRun(ctx.editor, run.id, { title: "כותרת ערוכה בידי אדם" });
      expect(await snap()).toBe(before);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).title).toBe("כותרת ערוכה בידי אדם");
      // an edited preview is recorded as written by a person
      expect((await db.lotDescriptionVersion.findFirstOrThrow({ where: { lotId: lots[0]!.lot.id }, orderBy: { version: "desc" } })).source).toBe("MANUAL");
      // the books' own analysis rows were not added to
      expect(await db.inventoryAnalysis.count({ where: { inventoryItemId: { in: lots.map((l) => l.item.id) } } })).toBe(1);
    });

    it("a composition change marks the description as needing an update, keeps it, and blocks applying an old proposal", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      await approveAll(lots);
      const run1 = await generateLotDescription(ctx.editor, lots[0]!.lot.id);
      await applyLotAiRun(ctx.editor, run1.id, {});
      const text = (await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).description;
      const run2 = await generateLotDescription(ctx.editor, lots[0]!.lot.id); // a fresh, not yet applied proposal

      await removeBookFromLot(ctx.editor, lots[0]!.lot.id, lots[2]!.item.id);
      const lot = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      expect(lot.descriptionNeedsUpdate).toBe(true);
      expect(lot.description).toBe(text); // not deleted
      expect(lot.aiDescriptionRunId).toBe(run1.id);
      const state = await getLotAiState(ctx.editor, lot.id);
      expect(state.descriptionNeedsUpdate).toBe(true);
      expect(state.appliedBasedOnOlderComposition).toBe(true);
      expect(state.runs.find((r) => r.id === run2.id)!.stale).toBe(true);
      await expect(applyLotAiRun(ctx.editor, run2.id, {})).rejects.toThrow(/הרכב הלוט השתנה/);
      expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).description).toBe(text); // nothing published automatically

      // a new run for the new composition can be applied; the flag clears
      const run3 = await generateLotDescription(ctx.editor, lot.id);
      expect((run3.members as unknown[]).length).toBe(2);
      await applyLotAiRun(ctx.editor, run3.id, {});
      expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).descriptionNeedsUpdate).toBe(false);

      // adding a book flags it again; discarding a proposal leaves the lot alone
      await addBooksToLot(ctx.editor, lot.id, { lotIds: [lots[2]!.lot.id] }).catch(() => undefined);
      const run4 = await generateLotDescription(ctx.editor, lot.id);
      await discardLotAiRun(ctx.editor, run4.id);
      await expect(applyLotAiRun(ctx.editor, run4.id, {})).rejects.toThrow(/נדחתה/);
    });

    it("refuses an ordinary single-book lot, an English-only answer is repeated once, an invalid answer fails the run without touching the lot", async () => {
      const solo = await setup(1);
      await expect(generateLotDescription(ctx.editor, solo.lots[0]!.lot.id)).rejects.toThrow(/אינו לוט משולב|לא לוט משולב/);
      const { catalog, lots } = await setup(2);
      await merge(catalog.id, lots);
      await approveAll(lots);
      let n = 0;
      fake.requests = [];
      fake.answer = () => (++n === 1 ? lotAnswer({ description: "This is a very long English description of the books in the lot that should be rejected for the language", title: "A lot of books in English language" }) : lotAnswer());
      const run = await generateLotDescription(ctx.editor, lots[0]!.lot.id);
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[1]!.userText).toContain("באנגלית");
      expect(run.requestCount).toBe(2);

      fake.answer = () => "not json at all";
      const before = await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } });
      await expect(generateLotDescription(ctx.editor, lots[0]!.lot.id)).rejects.toThrow(/נכשלה/);
      const failed = await db.lotAiRun.findFirstOrThrow({ where: { lotId: lots[0]!.lot.id, status: "FAILED" } });
      expect(failed.error).toBeTruthy();
      expect(failed.costUsd).not.toBeNull(); // the paid-for calls are recorded
      expect((await db.lot.findUniqueOrThrow({ where: { id: lots[0]!.lot.id } })).description).toBe(before.description);
      fake.answer = () => lotAnswer();
    });

    it("only the settings decide the model: the request has no model or provider field", async () => {
      const src = readFileSync(path.join(__dirname, "../../src/app/api/lots/[id]/ai/route.ts"), "utf8");
      const post = src.split("export const POST")[1]!.split("export const PATCH")[0]!;
      expect(post).not.toContain("parseJson"); // the request carries no body at all: no model, no provider
      expect(post).not.toMatch(/model|provider/i);
    });
  });

  /* ─────────────────────────── sale, picking, shipping ─────────────────────────── */

  describe("commercial behaviour and warehouse", () => {
    it("selling a combined lot updates every book atomically; one lot, one outcome; a pick task per book", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      const lotId = lots[0]!.lot.id;
      await setLotCommercialStatus(ctx.editor, lotId, { status: "OFFERED" });
      for (const l of lots) expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } })).commercialStatus).toBe("OFFERED");

      await setLotCommercialStatus(ctx.editor, lotId, { status: "SOLD" });
      const lot = await db.lot.findUniqueOrThrow({ where: { id: lotId } });
      expect(lot.commercialStatus).toBe("SOLD");
      expect(lot.assignmentStatus).toBe("ENDED");
      // sold is not released: no pick task yet, the books stay where they are
      expect(await db.pickTask.count({ where: { lotId } })).toBe(0);
      for (const l of lots) expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } })).physicalStatus).not.toBe("AWAITING_PICK");
      await releaseSold(lotId);
      for (const l of lots) {
        const i = await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } });
        expect(i.commercialStatus).toBe("SOLD");
        expect(i.physicalStatus).toBe("AWAITING_PICK");
      }
      const tasks = await db.pickTask.findMany({ where: { lotId } });
      expect(tasks).toHaveLength(3);
      expect(new Set(tasks.map((t) => t.inventoryItemId)).size).toBe(3);
      expect((await members(lotId)).every((m) => !m.isActive)).toBe(true);
      const f = await lotFulfilment(lotId);
      expect(f.label).toBe("נאספו 0 מתוך 3 ספרים");
      expect(f.readyToShip).toBe(false);
      // the merged-away lots cannot be given their own outcome
      await expect(setLotCommercialStatus(ctx.editor, lots[1]!.lot.id, { status: "SOLD" })).rejects.toThrow(/אוחד/);
    });

    it("the whole sale fails or succeeds together (a failure on one book leaves all books untouched)", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      const lotId = lots[0]!.lot.id;
      // the sale itself changes every book together
      await setLotCommercialStatus(ctx.editor, lotId, { status: "SOLD" });
      for (const l of lots) expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } })).commercialStatus).toBe("SOLD");
      // one book is already shipped by hand: releasing the lot fails as a whole and leaves every book untouched
      await db.inventoryItem.update({ where: { id: lots[2]!.item.id }, data: { physicalStatus: "SHIPPED" } });
      await expect(releaseSold(lotId)).rejects.toThrow();
      expect(await db.pickTask.count({ where: { lotId } })).toBe(0);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[0]!.item.id } })).physicalStatus).not.toBe("AWAITING_PICK");
    });

    it("unsold / withdrawn: every book gets the outcome and can be assigned again, together or apart", async () => {
      const { catalog, lots } = await setup(2);
      await merge(catalog.id, lots);
      await setLotCommercialStatus(ctx.editor, lots[0]!.lot.id, { status: "UNSOLD" });
      for (const l of lots) expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } })).commercialStatus).toBe("UNSOLD");
      const next = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `N${++seq}-${Date.now() % 100000}`, name: "הבא" });
      const separate = await assignToCatalog(ctx.editor, lots[1]!.item.id, { catalogId: next.id });
      expect(separate.catalogId).toBe(next.id);
      const again = await assignToCatalog(ctx.editor, lots[0]!.item.id, { catalogId: next.id });
      expect(again.id).not.toBe(separate.id);
      // a book of a still-active combined lot cannot be assigned elsewhere
      const c2 = await setup(2);
      await merge(c2.catalog.id, c2.lots);
      await expect(assignToCatalog(ctx.editor, c2.lots[1]!.item.id, { catalogId: next.id, replaceActive: true })).rejects.toThrow(/לוט משולב/);
    });

    it("picking: each book is scanned on its own; the lot is ready only when every book is packed; one scanned book never ships the lot", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, lots);
      const lotId = lots[0]!.lot.id;
      await setLotCommercialStatus(ctx.editor, lotId, { status: "SOLD" });
      await releaseSold(lotId);

      await db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, lots[0]!.item.id));
      let f = await lotFulfilment(lotId);
      expect(f.label).toBe("נאספו 1 מתוך 3 ספרים");
      expect(f.readyToShip).toBe(false);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: lots[1]!.item.id } })).physicalStatus).toBe("AWAITING_PICK");

      for (const l of lots.slice(1)) await db.$transaction((tx) => pickItemTx(tx, ctx.warehouse, l.item.id));
      f = await lotFulfilment(lotId);
      expect(f.label).toBe("נאספו 3 מתוך 3 ספרים");
      expect(f.readyToShip).toBe(false); // picked, not yet packed

      const tasks = await db.pickTask.findMany({ where: { lotId }, orderBy: { createdAt: "asc" } });
      await markPacked(ctx.warehouse, tasks[0]!.id);
      await markPacked(ctx.warehouse, tasks[1]!.id);
      expect((await lotFulfilment(lotId)).readyToShip).toBe(false); // 2 of 3 packed
      await markShipped(ctx.warehouse, tasks[0]!.id);
      f = await lotFulfilment(lotId);
      expect(f.shipped).toBe(1);
      expect(f.allShipped).toBe(false);
      expect(f.readyToShip).toBe(false);
      // every book keeps its own physical status; the other books are not "shipped"
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: tasks[1]!.inventoryItemId } })).physicalStatus).toBe("PACKED");
      await markPacked(ctx.warehouse, tasks[2]!.id);
      expect((await lotFulfilment(lotId)).readyToShip).toBe(true);
    });

    it("book photo status and counts roll up into the lot (derived status of several books)", async () => {
      const { catalog, lots } = await setup(2);
      await merge(catalog.id, lots);
      const lotId = lots[0]!.lot.id;
      await db.$transaction((tx) => changeStatus(tx, ctx.editor, lots[0]!.item.id, "PHOTO", "COMPLETED"));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lotId } })).status).toBe("IN_PROGRESS");
      await db.$transaction((tx) => changeStatus(tx, ctx.editor, lots[1]!.item.id, "PHOTO", "COMPLETED"));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lotId } })).status).toBe("COMPLETED");
      await db.$transaction((tx) => changeStatus(tx, ctx.editor, lots[1]!.item.id, "PHOTO", "NEEDS_RESHOOT"));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lotId } })).status).toBe("NEEDS_RESHOOT");
      // setting the status on the lot applies it to every book
      await updateLot(ctx.editor, lotId, { status: "COMPLETED" });
      for (const l of lots) expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: l.item.id } })).photoStatus).toBe("COMPLETED");
    });
  });

  /* ─────────────────────────── compatibility & migration ─────────────────────────── */

  describe("compatibility with ordinary lots and the migration", () => {
    it("lot numbers always run 1..N: an old gap (merge done before) is healed on view, and deleting a lot closes the gap", async () => {
      const { catalog, lots } = await setup(5);
      await merge(catalog.id, [lots[1]!, lots[2]!]);
      // simulate the state an older version left behind: gap + merged lot still on a positive number
      await db.lot.updateMany({ where: { catalogId: catalog.id, mergedIntoLotId: { not: null } }, data: { lotNumber: 2 + 1000 } });
      await db.lot.update({ where: { id: lots[4]!.lot.id }, data: { lotNumber: 6 } });
      await db.lot.update({ where: { id: lots[3]!.lot.id }, data: { lotNumber: 4 } });
      await healLotNumbers(catalog.id);
      const nums = async () => (await listLots(ctx.editor, catalog.id)).map((x) => x.lotNumber);
      expect(await nums()).toEqual([1, 2, 3, 4]);
      await healLotNumbers(catalog.id); // idempotent
      expect(await nums()).toEqual([1, 2, 3, 4]);
      await deleteLot(ctx.editor, lots[3]!.lot.id);
      expect(await nums()).toEqual([1, 2, 3]);
    });

    it("an ordinary lot behaves as before: one founding member, status sync, list row, sale, quick add and CSV row", async () => {
      const catalog = await createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `Q${++seq}-${Date.now() % 100000}`, name: "רגיל" });
      const lot = await createLot(ctx.editor, catalog.id, { title: "ספר מהיר", consignorId: anna.id });
      const m = await members(lot.id);
      expect(m).toHaveLength(1);
      expect(m[0]!.inventoryItemId).toBe(lot.inventoryItemId);
      expect(m[0]!.originLotId).toBeNull();
      expect(m[0]!.isActive).toBe(true);
      const rows = await listLots(ctx.editor, catalog.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ bookCount: 1, inventoryNumber: expect.any(String) });
      await db.$transaction((tx) => changeStatus(tx, ctx.editor, lot.inventoryItemId, "PHOTO", "COMPLETED"));
      expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe("COMPLETED");
      await setLotCommercialStatus(ctx.editor, lot.id, { status: "SOLD" });
      expect(await db.pickTask.count({ where: { lotId: lot.id } })).toBe(0);
      await releaseSold(lot.id);
      expect(await db.pickTask.count({ where: { lotId: lot.id } })).toBe(1);
      expect((await lotsCsv(ctx.org.id, catalog.id)).body).toContain(",1,");
      // a single-book lot rejects the combined-only AI action
      await expect(generateLotDescription(ctx.editor, lot.id)).rejects.toThrow();
    });

    it("the migration's data step: every existing lot gets exactly one member, nothing else changes; the constraints hold", async () => {
      const { catalog, lots } = await setup(3);
      await merge(catalog.id, [lots[0]!, lots[1]!]);
      const sql = readFileSync(path.join(__dirname, "../../prisma/migrations/20261110090000_combined_lots/migration.sql"), "utf8");
      const insert = sql.slice(sql.indexOf('INSERT INTO "LotMember"'), sql.indexOf(";", sql.indexOf('FROM "Lot" l')) + 1);
      expect(insert).toContain("INSERT INTO");
      // simulate the pre-migration state of this organization (lots without members), then run the data step for it
      const lotIds = (await db.lot.findMany({ where: { organizationId: ctx.org.id }, select: { id: true } })).map((l) => l.id);
      const lotsBefore = ser(await db.lot.findMany({ where: { organizationId: ctx.org.id }, orderBy: { id: "asc" } }));
      const itemsBefore = ser(await db.inventoryItem.findMany({ where: { organizationId: ctx.org.id }, orderBy: { id: "asc" } }));
      await db.lotMember.deleteMany({ where: { organizationId: ctx.org.id } });
      await db.$executeRawUnsafe(insert.replace('FROM "Lot" l', `FROM "Lot" l WHERE l."organizationId" = '${ctx.org.id}'`));
      const rows = await db.lotMember.findMany({ where: { organizationId: ctx.org.id } });
      expect(rows).toHaveLength(lotIds.length);
      expect(new Set(rows.map((r) => r.lotId)).size).toBe(lotIds.length); // exactly one per lot
      for (const r of rows) {
        const lot = await db.lot.findUniqueOrThrow({ where: { id: r.lotId } });
        expect(r.inventoryItemId).toBe(lot.inventoryItemId);
        expect(r.isActive).toBe(lot.assignmentStatus === "ACTIVE");
        expect(r.sortOrder).toBe(1);
      }
      expect(ser(await db.lot.findMany({ where: { organizationId: ctx.org.id }, orderBy: { id: "asc" } }))).toBe(lotsBefore);
      expect(ser(await db.inventoryItem.findMany({ where: { organizationId: ctx.org.id }, orderBy: { id: "asc" } }))).toBe(itemsBefore);
      // the schema guarantees: a book cannot be present twice in a lot, nor active in two lots
      const active = rows.find((r) => r.isActive)!;
      await expect(db.lotMember.create({ data: { organizationId: ctx.org.id, lotId: active.lotId, inventoryItemId: active.inventoryItemId, sortOrder: 2 } })).rejects.toThrow();
      const otherLot = lots.find((l) => l.lot.id !== active.lotId && !rows.find((r) => r.lotId === l.lot.id && !r.isActive))!;
      await expect(db.lotMember.create({ data: { organizationId: ctx.org.id, lotId: otherLot.lot.id, inventoryItemId: active.inventoryItemId, sortOrder: 5, isActive: true } })).rejects.toThrow();
    });
  });

});
