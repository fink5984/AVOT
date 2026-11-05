import "server-only";
import { z } from "zod";
import { db } from "../db";
import { notFound } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";

/*
 * Photographer notes (הערות המצלם): free text kept on the physical book, separate from internalNotes. The editor
 * autosaves, so requests can arrive late or out of order: every save carries a client edit counter (`rev`, a
 * millisecond timestamp that only grows) and is applied only if it is newer than what is stored. A delayed old
 * request therefore can never overwrite a newer note.
 */

export const PHOTOGRAPHER_NOTES_MAX = 5000;

export const photographerNotesSchema = z.object({
  text: z.string().max(PHOTOGRAPHER_NOTES_MAX, `ההערה ארוכה מדי (עד ${PHOTOGRAPHER_NOTES_MAX} תווים)`),
  rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** One audit entry per editing burst, not per keystroke or per autosave. */
const AUDIT_EVERY_MS = 10 * 60 * 1000;

export interface PhotographerNotesState {
  text: string;
  rev: number | null;
  updatedAt: string | null;
  updatedByName: string | null;
}

export async function readPhotographerNotes(orgId: string, itemId: string): Promise<PhotographerNotesState> {
  const it = await db.inventoryItem.findFirst({
    where: { id: itemId, organizationId: orgId },
    select: { photographerNotes: true, photographerNotesRev: true, photographerNotesAt: true, photographerNotesById: true },
  });
  if (!it) throw notFound("הספר");
  const by = it.photographerNotesById ? await db.user.findUnique({ where: { id: it.photographerNotesById }, select: { name: true } }) : null;
  return { text: it.photographerNotes ?? "", rev: it.photographerNotesRev === null ? null : Number(it.photographerNotesRev), updatedAt: it.photographerNotesAt?.toISOString() ?? null, updatedByName: by?.name ?? null };
}

/**
 * Stores the note when `rev` is newer than the stored one. Returns whether it was applied and the state that is now
 * stored, so a client whose save was superseded (another tab, another photographer) can show the winning text.
 */
export async function savePhotographerNotes(user: UserPrincipal, itemId: string, input: z.infer<typeof photographerNotesSchema>) {
  const text = input.text.replace(/\r\n/g, "\n");
  const r = await db.inventoryItem.updateMany({
    where: { id: itemId, organizationId: user.organizationId, OR: [{ photographerNotesRev: null }, { photographerNotesRev: { lt: BigInt(input.rev) } }] },
    data: { photographerNotes: text.trim() ? text : null, photographerNotesRev: BigInt(input.rev), photographerNotesAt: new Date(), photographerNotesById: user.userId },
  });
  const applied = r.count === 1;
  if (applied) {
    const recent = await db.auditLog.findFirst({
      where: { inventoryItemId: itemId, action: "inventory.photographer_notes", userId: user.userId, createdAt: { gte: new Date(Date.now() - AUDIT_EVERY_MS) } },
      select: { id: true },
    });
    if (!recent) await audit(user, { action: "inventory.photographer_notes", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { length: text.trim().length } });
  }
  return { applied, state: await readPhotographerNotes(user.organizationId, itemId) };
}
