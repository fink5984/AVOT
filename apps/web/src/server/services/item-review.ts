import "server-only";
import { z } from "zod";
import { db, type Tx } from "../db";
import { AppError, forbidden } from "../errors";
import { audit } from "../audit";
import type { UserPrincipal } from "../auth/principal";
import { canUser } from "../auth/permissions";
import { changeStatus } from "./item-status";
import { getItemOrThrow } from "./inventory";
import { AI_WRITABLE, FIELD_LABEL, type AiWritable } from "../ai/mapper";
import { sameText } from "../ai/text";

/*
 * "מצב פרטי הפריט" - the human review of an item's details. Separate from photo, physical, commercial status and
 * from the AI run state. Transitions go through changeStatus (dimension REVIEW), so each one is an
 * InventoryStatusEvent with the user and the server time.
 *
 *   NOT_STARTED ──AI success──▶ PENDING_REVIEW ──"התחל בדיקה" / first edit──▶ IN_REVIEW ──"סיימתי לבדוק - אשר פרטים"──▶ APPROVED
 *   APPROVED ──material change by a person──▶ IN_REVIEW (the approval is no longer valid)
 *   any ──AI success (first run or approved re-analysis)──▶ PENDING_REVIEW
 *
 * Only the explicit approve request moves an item to APPROVED.
 */

/** Changes to these fields are "material": they invalidate an approval. */
export const MATERIAL_FIELDS = AI_WRITABLE;

export function changedMaterialFields(before: Record<string, unknown>, patch: Record<string, unknown>): AiWritable[] {
  return MATERIAL_FIELDS.filter((f) => patch[f] !== undefined && (f === "itemType" ? patch[f] !== before[f] : !sameText(patch[f] as string | null, before[f] as string | null)));
}

/**
 * Called inside the transaction of a human edit. A material change of an APPROVED item withdraws the approval
 * (→ IN_REVIEW by the editing user); a material change of an item waiting for review starts the review.
 */
export async function reviewAfterHumanEdit(tx: Tx, user: UserPrincipal, item: { id: string; reviewStatus: string; approvedAt?: Date | null; approvedById?: string | null; approvedVersion?: number | null }, changed: AiWritable[]) {
  if (!changed.length) return null;
  if (item.reviewStatus === "APPROVED") {
    await changeStatus(tx, user, item.id, "REVIEW", "IN_REVIEW", { reason: `האישור בוטל: שונו ${changed.map((f) => FIELD_LABEL[f]).join(", ")}`, refType: "edit" });
    await audit(user, { action: "item_review.invalidated", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { fields: changed, previousApprovedById: item.approvedById ?? null, previousApprovedAt: item.approvedAt?.toISOString() ?? null, previousApprovedVersion: item.approvedVersion ?? null } }, tx);
    return "invalidated" as const;
  }
  if (item.reviewStatus === "PENDING_REVIEW") {
    await changeStatus(tx, user, item.id, "REVIEW", "IN_REVIEW", { reason: "התחיל לערוך את הפרטים", refType: "edit" });
    await audit(user, { action: "item_review.started", entityType: "inventory", entityId: item.id, inventoryItemId: item.id, data: { auto: true } }, tx);
    return "started" as const;
  }
  return null;
}

export async function startReview(user: UserPrincipal, itemId: string) {
  await getItemOrThrow(user.organizationId, itemId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { reviewStatus: true } });
    if (item.reviewStatus === "IN_REVIEW") return { reviewStatus: "IN_REVIEW" as const };
    const changed = await changeStatus(tx, user, itemId, "REVIEW", "IN_REVIEW", { reason: "התחיל בדיקה אנושית", refType: "review" });
    if (changed) await audit(user, { action: "item_review.started", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { from: item.reviewStatus } }, tx);
    return { reviewStatus: "IN_REVIEW" as const };
  });
}

export const approveSchema = z.object({
  /** the detailsVersion the reviewer saw: details changed since (AI result, another user) cannot be approved unseen */
  detailsVersion: z.number().int().min(0),
});

/** "סיימתי לבדוק - אשר פרטים". Also records, on the latest AI run, which AI values the reviewer changed. */
export async function approveReview(user: UserPrincipal, itemId: string, input: z.infer<typeof approveSchema>) {
  // the final approval is its own permission (item.review.approve): checked here as well as in the route
  if (!canUser(user, "item.review.approve")) throw forbidden();
  await getItemOrThrow(user.organizationId, itemId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
    const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    if (item.detailsVersion !== input.detailsVersion) throw new AppError("CONFLICT", "פרטי הפריט השתנו מאז שנטענו (ניתוח AI או משתמש אחר). רעננו את הדף ובדקו שוב לפני האישור.");
    if (item.aiStatus === "QUEUED" || item.aiStatus === "RUNNING") throw new AppError("CONFLICT", "ניתוח AI פעיל על הפריט. אפשר לאשר אחרי שיסתיים.");
    if (item.reviewStatus === "APPROVED") return { reviewStatus: "APPROVED" as const };
    await changeStatus(tx, user, itemId, "REVIEW", "APPROVED", { reason: "סיום בדיקה ואישור", refType: "review" });
    await tx.inventoryItem.update({ where: { id: itemId }, data: { approvedVersion: item.detailsVersion } });

    // provider comparison: how many AI-written values did the person change before approving
    const run = await tx.inventoryAnalysis.findFirst({ where: { inventoryItemId: itemId, status: "COMPLETED", kind: "catalog_ai", restoredAt: null }, orderBy: { finishedAt: "desc" } });
    let outcome: { aiWritten: number; changed: string[]; kept: string[] } | null = null;
    if (run?.applied) {
      const written = ((run.applied as { written?: Partial<Record<AiWritable, string>> }).written ?? {}) as Partial<Record<AiWritable, string>>;
      const changed: string[] = [];
      const kept: string[] = [];
      for (const [f, v] of Object.entries(written) as [AiWritable, string][]) {
        const now = item[f] as string | null;
        (f === "itemType" ? now === v : sameText(now, v)) ? kept.push(f) : changed.push(f);
      }
      outcome = { aiWritten: Object.keys(written).length, changed, kept };
      await tx.inventoryAnalysis.update({ where: { id: run.id }, data: { reviewOutcome: { ...outcome, approvedAt: new Date().toISOString(), approvedById: user.userId } } });
    }
    await audit(user, { action: "item_review.approved", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, data: { detailsVersion: item.detailsVersion, from: item.reviewStatus, runId: run?.id ?? null, changedAiFields: outcome?.changed ?? [] } }, tx);
    return { reviewStatus: "APPROVED" as const };
  });
}
