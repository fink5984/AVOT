import "server-only";
import { z } from "zod";
import type { ItemReviewNote, ReviewNoteStatus } from "@prisma/client";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { can } from "../auth/permissions";
import type { UserPrincipal } from "../auth/principal";

/*
 * "הערות לבדיקה": internal, UNVERIFIED remarks on a physical book. They belong to the book (inventory item), so the
 * book page in the inventory and the book's lot in every catalog show the very same rows.
 *
 * HARD RULE: nothing in this file, and no row of ItemReviewNote, may ever reach an AI request - not the first analysis,
 * a re-analysis, a targeted addition, the research queries or the combined-lot description - and a note marked
 * "verified" is not copied anywhere automatically either (the editor adds the fact to the book's details by hand).
 * The AI code never imports this module (test/review-notes-isolation.test.ts keeps it that way).
 *
 * Notes are never deleted. Handling one records who and when plus an optional written conclusion, and every change is
 * an audit entry on the book's history.
 */

export const REVIEW_NOTE_MAX = 2000;
export const REVIEW_CONCLUSION_MAX = 2000;

export const addNoteSchema = z.object({ text: z.string().trim().min(1, "יש לכתוב את ההערה").max(REVIEW_NOTE_MAX, `ההערה ארוכה מדי (עד ${REVIEW_NOTE_MAX} תווים)`) });
export const patchNoteSchema = z
  .object({
    text: z.string().trim().min(1, "יש לכתוב את ההערה").max(REVIEW_NOTE_MAX).optional(),
    status: z.enum(["OPEN", "VERIFIED", "NOT_VERIFIED"]).optional(),
    conclusion: z.string().trim().max(REVIEW_CONCLUSION_MAX).nullish(),
    /** the state the client saw: another person's handling in the meantime is refused, never overwritten */
    expectedStatus: z.enum(["OPEN", "VERIFIED", "NOT_VERIFIED"]),
  })
  .refine((v) => v.text !== undefined || v.status !== undefined || v.conclusion !== undefined, "אין מה לעדכן");

export interface ReviewNoteDto {
  id: string;
  itemId: string;
  text: string;
  status: ReviewNoteStatus;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  conclusion: string | null;
}

async function namesOf(orgId: string, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, string>();
  return new Map((await db.user.findMany({ where: { id: { in: want }, organizationId: orgId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

function toDto(n: ItemReviewNote, names: Map<string, string>): ReviewNoteDto {
  return {
    id: n.id,
    itemId: n.inventoryItemId,
    text: n.text,
    status: n.status,
    createdAt: n.createdAt.toISOString(),
    createdBy: n.createdById ? (names.get(n.createdById) ?? null) : null,
    updatedAt: n.updatedAt.toISOString(),
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
    resolvedBy: n.resolvedById ? (names.get(n.resolvedById) ?? null) : null,
    conclusion: n.conclusion,
  };
}

/** Notes of several books (a combined lot shows each book's own), open ones first, then newest first. */
export async function listReviewNotes(orgId: string, itemIds: string[]): Promise<Map<string, ReviewNoteDto[]>> {
  const rows = await db.itemReviewNote.findMany({ where: { organizationId: orgId, inventoryItemId: { in: itemIds } }, orderBy: { createdAt: "desc" } });
  const names = await namesOf(orgId, rows.flatMap((r) => [r.createdById, r.resolvedById]));
  const out = new Map<string, ReviewNoteDto[]>(itemIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.inventoryItemId)!.push(toDto(r, names));
  for (const list of out.values()) list.sort((a, b) => Number(b.status === "OPEN") - Number(a.status === "OPEN"));
  return out;
}

/** How many OPEN notes each book has (the lists' compact badge). Books without any are absent from the map. */
export async function openNoteCounts(orgId: string, itemIds: string[]): Promise<Map<string, number>> {
  if (!itemIds.length) return new Map();
  const rows = await db.itemReviewNote.groupBy({ by: ["inventoryItemId"], where: { organizationId: orgId, inventoryItemId: { in: itemIds }, status: "OPEN" }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.inventoryItemId, r._count._all]));
}

/**
 * One cheap number for the shared poll: open count and the newest change. When either differs from what a page holds,
 * the page refreshes its notes (so a note added or handled by somebody else appears without a manual reload).
 */
export async function noteStamp(orgId: string, itemId: string) {
  const [open, last] = await Promise.all([
    db.itemReviewNote.count({ where: { organizationId: orgId, inventoryItemId: itemId, status: "OPEN" } }),
    db.itemReviewNote.aggregate({ where: { organizationId: orgId, inventoryItemId: itemId }, _max: { updatedAt: true }, _count: { _all: true } }),
  ]);
  return { open, total: last._count._all, rev: last._max.updatedAt?.getTime() ?? 0 };
}

export async function addReviewNote(user: UserPrincipal, itemId: string, input: z.infer<typeof addNoteSchema>) {
  const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId }, select: { id: true } });
  if (!item) throw notFound("הספר");
  const note = await db.itemReviewNote.create({ data: { organizationId: user.organizationId, inventoryItemId: itemId, text: input.text, createdById: user.userId } });
  await audit(user, { action: "review_note.added", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { noteId: note.id, text: input.text.slice(0, 300) } });
  return toDto(note, await namesOf(user.organizationId, [user.userId]));
}

export async function updateReviewNote(user: UserPrincipal, noteId: string, input: z.infer<typeof patchNoteSchema>) {
  const note = await db.itemReviewNote.findFirst({ where: { id: noteId, organizationId: user.organizationId } });
  if (!note) throw notFound("ההערה");
  const wantsStatus = input.status !== undefined && input.status !== note.status;
  const handles = wantsStatus || input.conclusion !== undefined;
  if (handles && !can(user.role, "reviewNote.resolve")) throw new AppError("FORBIDDEN", "אין הרשאה לסמן הערה כנבדקה");
  if (input.text !== undefined && note.status !== "OPEN") throw new AppError("CONFLICT", "הערה שטופלה נשמרת כפי שהיא בהיסטוריה. אפשר לפתוח אותה מחדש כדי לערוך.");
  const nextStatus = input.status ?? note.status;
  const nextConclusion = input.conclusion === undefined ? note.conclusion : input.conclusion?.trim() || null;
  // a conclusion belongs to a handled note
  if (input.conclusion !== undefined && nextStatus === "OPEN" && nextConclusion) throw new AppError("VALIDATION", "מסקנה נכתבת בעת סימון ההערה כנבדקה");
  const reopening = wantsStatus && nextStatus === "OPEN";
  const resolving = wantsStatus && nextStatus !== "OPEN";
  // optimistic: the client acted on what it saw; refuse if somebody else handled the note meanwhile (nothing silently overwritten)
  const r = await db.itemReviewNote.updateMany({
    where: { id: noteId, organizationId: user.organizationId, status: input.expectedStatus },
    data: {
      ...(input.text !== undefined ? { text: input.text } : {}),
      status: nextStatus,
      conclusion: reopening ? null : nextConclusion,
      ...(resolving ? { resolvedById: user.userId, resolvedAt: new Date() } : {}),
      ...(reopening ? { resolvedById: null, resolvedAt: null } : {}),
      // a conclusion edited on an already handled note keeps who first handled it, but the edit time is `updatedAt`
    },
  });
  if (r.count === 0) {
    const now = await db.itemReviewNote.findUnique({ where: { id: noteId } });
    const who = now?.resolvedById ? (await namesOf(user.organizationId, [now.resolvedById])).get(now.resolvedById) : null;
    throw new AppError("CONFLICT", now && now.status !== input.expectedStatus ? `ההערה כבר עודכנה${who ? ` על ידי ${who}` : " על ידי משתמש אחר"}. רעננו כדי לראות את המצב העדכני.` : "ההערה לא נמצאה", { code: "STALE_NOTE" });
  }
  const updated = await db.itemReviewNote.findUniqueOrThrow({ where: { id: noteId } });
  const action = reopening ? "review_note.reopened" : resolving ? (nextStatus === "VERIFIED" ? "review_note.verified" : "review_note.not_verified") : "review_note.edited";
  await audit(user, {
    action,
    entityType: "inventory",
    entityId: note.inventoryItemId,
    inventoryItemId: note.inventoryItemId,
    data: { noteId, ...(input.text !== undefined ? { previousText: note.text.slice(0, 300), text: input.text.slice(0, 300) } : {}), from: note.status, to: nextStatus, conclusion: nextConclusion?.slice(0, 300) ?? null },
  });
  return toDto(updated, await namesOf(user.organizationId, [updated.createdById, updated.resolvedById]));
}
