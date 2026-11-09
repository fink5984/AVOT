import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type InventoryItem } from "@prisma/client";
import { db, type Tx } from "../db";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { asJson } from "../json";
import type { UserPrincipal } from "../auth/principal";

/*
 * The item's ORIGINAL data: what existed before the first AI analysis (name, typed details, photographer notes).
 * A clean re-analysis is built from this and the photos only - never from the item's current fields, which may hold
 * the previous model's output (directly, or copied / rewritten / edited from it).
 *
 *   A. original data (this baseline)            -> sent to every analysis
 *   B. later human additions                    -> NOT sent in a clean run (the first model never had them)
 *   C. earlier AI output                        -> never sent, in any form
 *
 * The baseline is fixed once set. It is captured when the first analysis is requested; for items analysed before this
 * existed it is reconstructed from what is PROVEN to be pre-AI: the values the first completed run recorded when it
 * started (baseValues). Anything that cannot be proven is listed in `missing` and is not sent; only an admin can
 * confirm the current values as the baseline (audited).
 */

/** The item fields in the baseline. The catalog headline / description are AI products and are never part of it. */
export const BASELINE_FIELDS = ["title", "subtitle", "author", "printPlace", "printYear", "publisher", "edition", "extent", "bibliographicNotes", "conditionNotes", "itemType"] as const;
export type BaselineField = (typeof BASELINE_FIELDS)[number];

export type BaselineSource = "captured_before_first_analysis" | "reconstructed_from_first_run" | "admin_confirmed";

export interface OriginalBaseline {
  version: 1;
  capturedAt: string;
  source: BaselineSource;
  /** fields (and notes) whose pre-analysis value could not be proven: they are not sent */
  missing: string[];
  fields: Record<Exclude<BaselineField, "itemType">, string | null> & { itemType: string | null };
  photographerNotes: string | null;
  categoryNotes: { category: string; note: string }[];
  /** sha256 (16 hex) of fields + notes: equal hash = the same original data */
  hash: string;
}

const hashOf = (b: Omit<OriginalBaseline, "hash" | "capturedAt" | "source" | "missing" | "version">) => createHash("sha256").update(JSON.stringify([b.fields, b.photographerNotes, b.categoryNotes])).digest("hex").slice(0, 16);

type ItemWithNotes = InventoryItem & { categoryNotes: { category: string; note: string | null }[] };

const notesOf = (item: ItemWithNotes) => item.categoryNotes.filter((c) => c.note?.trim()).map((c) => ({ category: c.category as string, note: c.note as string })).sort((a, b) => a.category.localeCompare(b.category));

function make(fields: OriginalBaseline["fields"], item: ItemWithNotes, source: BaselineSource, missing: string[]): OriginalBaseline {
  const core = { fields, photographerNotes: item.photographerNotes?.trim() ? item.photographerNotes : null, categoryNotes: notesOf(item) };
  return { version: 1, capturedAt: new Date().toISOString(), source, missing, ...core, hash: hashOf(core) };
}

const currentFields = (item: ItemWithNotes): OriginalBaseline["fields"] =>
  Object.fromEntries(BASELINE_FIELDS.map((f) => [f, f === "itemType" ? (item.itemType === "UNKNOWN" ? null : item.itemType) : (item[f] as string | null) ?? null])) as OriginalBaseline["fields"];

/**
 * What the baseline of this item is (or would be), without saving anything. An item that was never analysed:
 * its current data IS the original. An analysed item: rebuilt from the first completed run's start-of-run values.
 */
export async function computeBaseline(item: ItemWithNotes, tx: Tx | typeof db = db): Promise<OriginalBaseline> {
  if (item.originalBaseline) return item.originalBaseline as unknown as OriginalBaseline;
  const everAnalysed = item.aiCompletedAt !== null || !!(await tx.inventoryAnalysis.findFirst({ where: { inventoryItemId: item.id, kind: "catalog_ai", status: "COMPLETED" }, select: { id: true } }));
  if (!everAnalysed) return make(currentFields(item), item, "captured_before_first_analysis", []);
  const first = await tx.inventoryAnalysis.findFirst({ where: { inventoryItemId: item.id, kind: "catalog_ai", status: "COMPLETED", baseValues: { not: Prisma.DbNull } }, orderBy: { createdAt: "asc" }, select: { baseValues: true } });
  const base = (first?.baseValues ?? null) as Record<string, string | null> | null;
  const missing: string[] = [];
  const fields = Object.fromEntries(
    BASELINE_FIELDS.map((f) => {
      if (!base || !(f in base)) {
        missing.push(f);
        return [f, null];
      }
      const v = base[f] ?? null;
      return [f, f === "itemType" ? (v === "UNKNOWN" ? null : v) : v];
    }),
  ) as OriginalBaseline["fields"];
  // the photographer's notes are never written by the AI; the current ones are the best (unprovable) record of the originals
  return make(fields, item, "reconstructed_from_first_run", missing);
}

/** Saves the baseline once (never replaced here). Returns the one in force. */
export async function ensureBaseline(itemId: string, tx: Tx | typeof db = db): Promise<OriginalBaseline> {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, include: { categoryNotes: { select: { category: true, note: true } } } });
  if (item.originalBaseline) return item.originalBaseline as unknown as OriginalBaseline;
  const b = await computeBaseline(item, tx);
  await tx.inventoryItem.updateMany({ where: { id: itemId, originalBaseline: { equals: Prisma.DbNull } }, data: { originalBaseline: asJson(b), originalBaselineAt: new Date() } });
  const saved = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { originalBaseline: true } });
  return saved.originalBaseline as unknown as OriginalBaseline;
}

/** For the UI: the baseline status without saving. */
export async function baselineStatus(item: ItemWithNotes) {
  const b = await computeBaseline(item);
  return { source: b.source, partial: b.missing.length > 0, missing: b.missing, hash: b.hash, saved: !!item.originalBaseline, capturedAt: item.originalBaselineAt?.toISOString() ?? null };
}

/**
 * Admin correction: the CURRENT values become the baseline (the item's data is known to be right, or the original
 * could not be reconstructed). Explicit and logged; the previous baseline is kept in the audit entry.
 */
export async function confirmBaselineFromCurrent(user: UserPrincipal, itemId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
    const item = await tx.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId }, include: { categoryNotes: { select: { category: true, note: true } } } });
    if (!item) throw notFound("הספר");
    if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI פעיל על הפריט");
    const next = make(currentFields(item), item, "admin_confirmed", []);
    await tx.inventoryItem.update({ where: { id: itemId }, data: { originalBaseline: asJson(next), originalBaselineAt: new Date() } });
    await audit(user, { action: "ai.baseline_confirmed", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: asJson({ previous: item.originalBaseline ?? null, hash: next.hash }) }, tx);
    return next;
  });
}
