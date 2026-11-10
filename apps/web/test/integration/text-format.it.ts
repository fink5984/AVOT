import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createCatalog } from "@/server/services/catalogs";
import { createConsignor } from "@/server/services/consignors";
import { createLot, duplicateLot, lotInputSchema, lotPatchSchema, moveLotToCatalog, updateLot } from "@/server/services/lots";
import { createItem, itemPatchSchema, updateItem } from "@/server/services/inventory";
import { assignToCatalog } from "@/server/services/assignments";
import { lotsCsv } from "@/server/services/exports";
import { ITEM_FORMAT_FIELDS, readTextFormat } from "@/lib/rich-text";
import { hasDb, makeOrg } from "./helpers";

/* Bold / underline / color of the catalog description: kept beside the plain text, never inside it. */
describe.skipIf(!hasDb)("catalog description formatting (real database)", () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let consignorId: string;
  let seq = 0;
  beforeAll(async () => {
    ctx = await makeOrg("fmt");
    consignorId = (await createConsignor(ctx.editor, { name: "מפקיד" })).id;
  });
  const catalog = () => createCatalog(ctx.editor, { auctionHouseId: ctx.house.id, number: `F${++seq}-${Date.now() % 100000}`, name: "עיצוב" });
  const format = async (id: string) => readTextFormat((await db.lot.findUniqueOrThrow({ where: { id } })).textFormat);

  it("a lot saves formatting of its description with the text, keeps the text plain, and drops formatting that does not match", async () => {
    const c = await catalog();
    // as the API route does: the schema trims the text before the service sees it
    const lot = await createLot(
      ctx.editor,
      c.id,
      lotInputSchema.parse({
        title: "ספר",
        consignorId,
        shortDescription: "תקציר",
        description: "  תיאור מלא ",
        textFormat: { description: [{ t: "  " }, { t: "תיאור", b: true }, { t: " מלא " }] },
      }),
    );
    expect(lot.description).toBe("תיאור מלא");
    // trimmed together with its text
    expect(await format(lot.id)).toEqual({ description: [{ t: "תיאור", b: true }, { t: " מלא" }] });

    await updateLot(ctx.editor, lot.id, lotPatchSchema.parse({ textFormat: { description: [{ t: "תיאור", c: "#1d4ed8" }, { t: " מלא", u: true }] } }));
    expect(await format(lot.id)).toEqual({ description: [{ t: "תיאור", c: "#1d4ed8" }, { t: " מלא", u: true }] });
    // a formatting-only change is not a new text version
    expect(await db.lotDescriptionVersion.count({ where: { lotId: lot.id } })).toBe(1);

    // the export carries the plain text only
    const csv = (await lotsCsv(ctx.editor.organizationId, c.id)).body;
    expect(csv).toContain("תקציר");
    expect(csv).not.toContain("#1d4ed8");

    // the text changed without formatting (AI, plain editor): its old formatting goes
    await updateLot(ctx.editor, lot.id, { description: "תיאור חדש" });
    expect(await format(lot.id)).toEqual({});

    // formatting that spells another text is refused silently
    await updateLot(ctx.editor, lot.id, lotPatchSchema.parse({ textFormat: { description: [{ t: "something else", u: true }] } }));
    expect(await format(lot.id)).toEqual({});

    // only the description is formattable: formatting of the short description is not stored
    await updateLot(ctx.editor, lot.id, lotPatchSchema.parse({ textFormat: { shortDescription: [{ t: "תקציר", b: true }] } }));
    expect(await format(lot.id)).toEqual({});

    await updateLot(ctx.editor, lot.id, lotPatchSchema.parse({ textFormat: { description: [{ t: "תיאור חדש", b: true }] } }));
    expect(await format(lot.id)).toEqual({ description: [{ t: "תיאור חדש", b: true }] });
    await updateLot(ctx.editor, lot.id, lotPatchSchema.parse({ textFormat: { description: null } }));
    expect((await db.lot.findUniqueOrThrow({ where: { id: lot.id } })).textFormat).toBeNull();
  });

  it("a duplicate and a move to another catalog keep the formatting", async () => {
    const c = await catalog();
    const lot = await createLot(ctx.editor, c.id, lotInputSchema.parse({ title: "ספר", consignorId, description: "אדום כאן", textFormat: { description: [{ t: "אדום", c: "#b42318" }, { t: " כאן" }] } }));
    const copy = await duplicateLot(ctx.editor, lot.id, consignorId);
    expect(await format(copy.id)).toEqual({ description: [{ t: "אדום", c: "#b42318" }, { t: " כאן" }] });
    const target = await catalog();
    const moved = await moveLotToCatalog(ctx.editor, lot.id, target.id);
    expect(moved.id).not.toBe(lot.id);
    expect(await format(moved.id)).toEqual({ description: [{ t: "אדום", c: "#b42318" }, { t: " כאן" }] });
  });

  it("refuses colors that are not plain hex values", () => {
    expect(lotPatchSchema.safeParse({ textFormat: { description: [{ t: "x", c: "red;background:url(x)" }] } }).success).toBe(false);
  });

  it("a book in inventory formats its catalog description only; text changes drop the formatting; a new lot starts from it", async () => {
    const { item } = await createItem(ctx.editor, { title: "ספר מלאי", consignorId } as never);
    const stored = async () => readTextFormat((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).textFormat, ITEM_FORMAT_FIELDS);
    const patch = (x: unknown) => itemPatchSchema.parse(x);

    await updateItem(
      ctx.editor,
      item.id,
      patch({
        catalogDescription: "תיאור מודגש",
        bibliographicNotes: "דף שער חסר",
        textFormat: { catalogDescription: [{ t: "תיאור ", b: true }, { t: "מודגש", c: "#b42318" }], bibliographicNotes: [{ t: "דף שער חסר", u: true }] },
      }),
    );
    // the other long texts are not formattable: that formatting is not stored
    expect(await stored()).toEqual({ catalogDescription: [{ t: "תיאור ", b: true }, { t: "מודגש", c: "#b42318" }] });

    // a formatting-only edit does not count as a change of the details
    const before = (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion;
    await updateItem(ctx.editor, item.id, patch({ textFormat: { catalogDescription: [{ t: "תיאור מודגש", u: true }] } }));
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).detailsVersion).toBe(before);
    expect((await stored()).catalogDescription).toEqual([{ t: "תיאור מודגש", u: true }]);

    // the new lot starts from the draft with its formatting
    const c = await catalog();
    const lot = await assignToCatalog(ctx.editor, item.id, { catalogId: c.id });
    expect(lot.description).toBe("תיאור מודגש");
    expect(await format(lot.id)).toEqual({ description: [{ t: "תיאור מודגש", u: true }] });

    // the text changed without formatting (AI, a plain editor): the old formatting goes
    await updateItem(ctx.editor, item.id, patch({ catalogDescription: "טקסט אחר" }));
    expect((await stored()).catalogDescription).toBeUndefined();

    // null clears everything
    await updateItem(ctx.editor, item.id, patch({ catalogDescription: "שוב", textFormat: { catalogDescription: [{ t: "שוב", b: true }] } }));
    await updateItem(ctx.editor, item.id, patch({ textFormat: null }));
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).textFormat).toBeNull();
  });
});
