import "server-only";
import { Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { asJson } from "../json";
import { sameText } from "../ai/text";
import { ITEM_FORMAT_FIELDS, formatToStore, readTextFormat, type TextFormat } from "@/lib/rich-text";

/*
 * Book ⇄ lot text. A book keeps a CATALOG DRAFT (InventoryItem.catalogHeadline / catalogDescription / textFormat); the
 * lot it is sold in has its own presentation (Lot.shortDescription / description / textFormat, versioned in
 * LotDescriptionVersion). For an ordinary lot (one book) the two are meant to be the same text, and they are kept so by
 * ONE rule, the one the AI result and the bibliographic fields already used:
 *
 *   a change of the book's draft flows into its lot only where the lot is still EMPTY or still holds the book's previous
 *   value. A lot text that was written on purpose for the catalog differs from the book's draft, so it is never
 *   overwritten - by a person's edit, by the AI, or by anything else. It shows as "dedicated to the catalog".
 *
 * The only ways to join two different texts are the two explicit, versioned actions (lot-draft-actions.ts). A combined
 * lot (several books) has its own shared description and is never written from one book.
 */

/** A lot whose presentation may still follow the book: assignment active, catalog not archived, not offered or sold yet. */
export function lotOpenForCatalogText(lot: { assignmentStatus: string; commercialStatus: string; catalog: { status: string } }) {
  return lot.assignmentStatus === "ACTIVE" && lot.catalog.status !== "ARCHIVED" && lot.commercialStatus === "ASSIGNED";
}

export interface DraftValues {
  catalogHeadline: string | null;
  catalogDescription: string | null;
  textFormat: unknown;
}

/** Does the lot show the book's draft? (what the lot page tells the editor; same comparison the sync uses) */
export function draftComparison(item: Pick<DraftValues, "catalogHeadline" | "catalogDescription">, lot: { shortDescription: string | null; description: string | null }) {
  const headline = sameText(item.catalogHeadline, lot.shortDescription);
  const description = sameText(item.catalogDescription, lot.description);
  return { headline, description, synced: headline && description };
}

/**
 * Called in the transaction of every change of a book's draft (a person's edit, an AI result, an undo).
 * Returns what was written to the lot, or null when the book has no ordinary, open lot / nothing followed.
 */
export async function followBookDraft(tx: Tx, itemId: string, before: DraftValues, after: DraftValues, userId: string | null, source: "MANUAL" | "AI") {
  const hChanged = (before.catalogHeadline ?? null) !== (after.catalogHeadline ?? null);
  const dChanged = (before.catalogDescription ?? null) !== (after.catalogDescription ?? null);
  const beforeSegs = readTextFormat(before.textFormat, ITEM_FORMAT_FIELDS).catalogDescription;
  const afterSegs = readTextFormat(after.textFormat, ITEM_FORMAT_FIELDS).catalogDescription;
  const fChanged = JSON.stringify(beforeSegs ?? null) !== JSON.stringify(afterSegs ?? null);
  if (!hChanged && !dChanged && !fChanged) return null;

  const member = await tx.lotMember.findFirst({ where: { inventoryItemId: itemId, isActive: true, removedAt: null }, include: { lot: { include: { catalog: { select: { status: true } } } } } });
  const lot = member?.lot;
  if (!lot || !lotOpenForCatalogText(lot)) return null;
  if ((await tx.lotMember.count({ where: { lotId: lot.id, removedAt: null } })) > 1) return null;

  const data: Prisma.LotUncheckedUpdateInput = {};
  const fields: string[] = [];
  if (hChanged && (!lot.shortDescription?.trim() || sameText(lot.shortDescription, before.catalogHeadline))) {
    data.shortDescription = after.catalogHeadline ?? null;
    fields.push("shortDescription");
  }
  // the lot's description follows when it was empty or held the book's previous text (also for a formatting-only change)
  const descFollows = dChanged ? !lot.description?.trim() || sameText(lot.description, before.catalogDescription) : fChanged && sameText(lot.description, after.catalogDescription);
  if (descFollows) {
    const text = dChanged ? (after.catalogDescription ?? null) : lot.description;
    if (dChanged) {
      data.description = text;
      fields.push("description");
    }
    const fmt: TextFormat = { ...readTextFormat(lot.textFormat) };
    const stored = formatToStore(afterSegs, text);
    if (stored) fmt.description = stored;
    else delete fmt.description;
    data.textFormat = Object.keys(fmt).length ? asJson(fmt) : Prisma.DbNull;
    if (!dChanged) fields.push("textFormat");
  }
  if (!fields.length) return null;
  const u = await tx.lot.update({ where: { id: lot.id }, data });
  let version: number | null = null;
  if (fields.some((f) => f === "shortDescription" || f === "description")) {
    const last = await tx.lotDescriptionVersion.aggregate({ where: { lotId: lot.id }, _max: { version: true } });
    version = (last._max.version ?? 0) + 1;
    await tx.lotDescriptionVersion.create({ data: { lotId: lot.id, version, title: u.title, shortDescription: u.shortDescription, description: u.description, source, createdById: userId } });
  }
  return { lotId: lot.id, fields, descriptionVersion: version };
}
