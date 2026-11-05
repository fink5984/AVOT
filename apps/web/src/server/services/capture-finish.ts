import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { log } from "../log";
import type { UserPrincipal } from "../auth/principal";
import { changeStatus } from "./item-status";
import { resolveItemTarget } from "./inventory";
import { getLotForUser } from "./lots";
import { createPrintJobs } from "./printing";

/*
 * "סיום פריט" / "סיום ספר וצור חדש" in the capture studio: marks the book's photography done AND queues exactly one
 * book label on the central print queue. Both steps are idempotent on `opId` (one per click, reused by every retry), so
 * a double click, a retry after a timeout or a response that never reached the browser neither re-marks nor reprints.
 * A printer problem never fails the finish: the status change is committed first and the label waits in the queue.
 */

export const finishCaptureSchema = z.object({
  status: z.enum(["NEEDS_RESHOOT", "PENDING_REVIEW", "COMPLETED"]),
  opId: z.string().uuid("מזהה פעולה לא תקין"),
});

export type FinishPrint = { jobId: string; status: string } | { error: string };

export async function finishCapture(user: UserPrincipal, targetId: string, input: z.infer<typeof finishCaptureSchema>) {
  const target = await resolveItemTarget(user.organizationId, targetId);
  if (!target) throw notFound("הספר");
  // opened from a catalog: the caller must be allowed to see that house, exactly as before
  if (target.lot) await getLotForUser(user, targetId);
  const itemId = target.itemId;

  const changed = await db.$transaction((tx) => changeStatus(tx, user, itemId, "PHOTO", input.status, { refType: "capture-finish", refId: input.opId }));
  if (changed) await audit(user, { action: "inventory.capture_finished", entityType: "inventory", entityId: itemId, inventoryItemId: itemId, lotId: target.lot?.id ?? null, data: { status: input.status } });

  let print: FinishPrint;
  try {
    const jobs = await createPrintJobs(user, { items: [{ type: "BOOK", id: itemId }], copies: 1, idemKey: `capture-finish:${itemId}:${input.opId}` }, { allowNoPrinter: true });
    print = { jobId: jobs[0]!.id, status: jobs[0]!.status };
  } catch (err) {
    log.error("capture finish: label not queued", { itemId, err });
    print = { error: err instanceof AppError ? err.message : "המדבקה לא נוספה לתור ההדפסה" };
  }
  return { itemId, status: input.status, changed, print };
}
