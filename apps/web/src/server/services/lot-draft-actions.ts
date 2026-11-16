import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { asJson } from "../json";
import { assertHouse } from "../auth/houses";
import type { UserPrincipal } from "../auth/principal";
import { ITEM_FORMAT_FIELDS, formatToStore, plainText, readTextFormat, type TextFormat } from "@/lib/rich-text";
import { lotOpenForCatalogText } from "./lot-sync";
import { updateItem } from "./inventory";

/*
 * The two EXPLICIT ways to make a lot's text and its book's catalog draft the same when they differ (the lot page shows
 * the difference and offers them). Nothing joins them silently - see lot-sync.ts. Both are versioned and audited, and
 * both refuse when somebody changed either side since the editor looked.
 *
 *   book_to_lot  the lot takes the book's draft (a new LotDescriptionVersion; the lot's previous text stays in its versions)
 *   lot_to_book  the book's draft takes the lot's text (a normal edit of the book: version, review status, history)
 */

export const draftActionSchema = z.object({
  direction: z.enum(["book_to_lot", "lot_to_book"]),
  /** what the editor saw: the book's detailsVersion and the lot's newest LotDescriptionVersion (0 = none) */
  expectedItemVersion: z.number().int().min(0),
  expectedLotVersion: z.number().int().min(0),
});

export async function resolveCatalogDraft(user: UserPrincipal, lotId: string, input: z.infer<typeof draftActionSchema>) {
  const lot = await db.lot.findFirst({ where: { id: lotId, organizationId: user.organizationId }, include: { catalog: { select: { status: true, auctionHouseId: true } }, item: true } });
  if (!lot) throw notFound("הפריט");
  assertHouse(user, lot.catalog.auctionHouseId);
  if ((await db.lotMember.count({ where: { lotId, removedAt: null } })) > 1) throw new AppError("CONFLICT", "בלוט משולב התיאור המשותף הוא ישות נפרדת ואינו מסונכרן עם ספר בודד.");
  if (!lotOpenForCatalogText(lot)) throw new AppError("CONFLICT", "הפריט כבר הוצע או נמכר, או שהקטלוג בארכיון: התיאור שבקטלוג אינו משתנה.");
  const lastVersion = (await db.lotDescriptionVersion.aggregate({ where: { lotId }, _max: { version: true } }))._max.version ?? 0;
  if (lot.item.detailsVersion !== input.expectedItemVersion || lastVersion !== input.expectedLotVersion) {
    throw new AppError("CONFLICT", "הכותרת או התיאור עודכנו בינתיים על ידי משתמש אחר. רעננו כדי לראות את המצב העדכני.", { code: "STALE_DRAFT" });
  }

  if (input.direction === "lot_to_book") {
    const segs = readTextFormat(lot.textFormat).description;
    const stored = formatToStore(segs, lot.description);
    await updateItem(
      user,
      lot.inventoryItemId,
      { catalogHeadline: lot.shortDescription, catalogDescription: lot.description, textFormat: stored ? { catalogDescription: stored } : null },
      { expectedVersion: input.expectedItemVersion, source: "manual" },
    );
    await audit(user, { action: "lot.draft_to_book", entityType: "lot", entityId: lotId, lotId, inventoryItemId: lot.inventoryItemId, data: { direction: input.direction } });
    return { direction: input.direction };
  }

  // book_to_lot
  const itemSegs = readTextFormat(lot.item.textFormat, ITEM_FORMAT_FIELDS).catalogDescription;
  const stored = formatToStore(itemSegs, lot.item.catalogDescription);
  await db.$transaction(async (tx) => {
    const fmt: TextFormat = { ...readTextFormat(lot.textFormat) };
    if (stored) fmt.description = stored;
    else delete fmt.description;
    const u = await tx.lot.update({ where: { id: lotId }, data: { shortDescription: lot.item.catalogHeadline, description: lot.item.catalogDescription, textFormat: Object.keys(fmt).length ? asJson(fmt) : Prisma.DbNull } });
    await tx.lotDescriptionVersion.create({ data: { lotId, version: lastVersion + 1, title: u.title, shortDescription: u.shortDescription, description: u.description, source: "MANUAL", createdById: user.userId } });
  });
  await audit(user, { action: "lot.draft_to_lot", entityType: "lot", entityId: lotId, lotId, inventoryItemId: lot.inventoryItemId, data: { direction: input.direction, replacedText: (lot.description ?? "").slice(0, 300), keptFormat: itemSegs ? plainText(itemSegs) === lot.item.catalogDescription : false } });
  return { direction: input.direction };
}
