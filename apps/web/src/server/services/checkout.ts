import "server-only";
import { z } from "zod";
import { db, type Tx } from "../db";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import type { Principal, UserPrincipal } from "../auth/principal";
import { changeStatus, storeBlockedReason } from "./item-status";
import { shipItemTx } from "./picking";
import { moveItemTx } from "./warehouse";

/*
 * Taking books out of the warehouse. ONE implementation used by the phone scanner (scanning.ts) and by the desktop
 * screens (inventory / warehouse) — same rules, same history, same permissions' meaning:
 *   TEMP   the book leaves its shelf for a while and must be shelved again ("awaiting storage")
 *   FINAL  the book leaves for good: it needs a pick/ship task; the task is closed as shipped
 * (Picking for an order is the existing pick-task flow: /warehouse/picking and the scanner's "ליקוט להזמנה".)
 */

export type CheckoutResult = { kind: "ok" | "noop" | "blocked"; message: string };

export async function removeTemporarilyTx(tx: Tx, principal: Principal, itemId: string, opts: { opId?: string | null; occurredAt?: Date } = {}): Promise<CheckoutResult> {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
  const blocked = storeBlockedReason(item.physicalStatus);
  if (blocked) return { kind: "blocked", message: blocked };
  if (!item.currentLocationId) return { kind: "noop", message: "הספר כבר אינו על מדף" };
  await moveItemTx(tx, principal, itemId, null, "MANUAL", { opId: opts.opId ?? null, occurredAt: opts.occurredAt, note: "הוצאה זמנית" });
  await changeStatus(tx, principal, itemId, "PHYSICAL", "AWAITING_STORAGE", { refType: opts.opId ? "scan" : "manual", reason: "הוצאה זמנית מהמדף" });
  return { kind: "ok", message: `${item.inventoryNumber} הוצא זמנית — יש להחזירו למדף` };
}

export async function removeFinallyTx(tx: Tx, principal: Principal, itemId: string, opts: { opId?: string | null; occurredAt?: Date } = {}): Promise<CheckoutResult> {
  const r = await shipItemTx(tx, principal, itemId, opts);
  if (r.kind === "none") return { kind: "blocked", message: "לספר אין משימת משלוח — הוצאה סופית נעשית לספר שנמכר" };
  if (r.kind === "already") return { kind: "noop", message: "הספר כבר נשלח" };
  return { kind: "ok", message: "הספר הוצא סופית (נשלח)" };
}

export const bulkCheckoutSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  kind: z.enum(["TEMP", "FINAL"]),
});

/** Desktop bulk action. Each book is its own transaction: one that cannot be taken out never stops the rest. */
export async function bulkCheckout(user: UserPrincipal, input: z.infer<typeof bulkCheckoutSchema>) {
  const done: string[] = [];
  const skipped: { itemId: string; message: string }[] = [];
  for (const itemId of input.itemIds) {
    const item = await db.inventoryItem.findFirst({ where: { id: itemId, organizationId: user.organizationId, deletionRequestedAt: null }, select: { id: true } });
    if (!item) throw notFound("הספר");
    try {
      const r = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${itemId}::uuid FOR UPDATE`;
        return input.kind === "TEMP" ? removeTemporarilyTx(tx, user, itemId) : removeFinallyTx(tx, user, itemId);
      });
      if (r.kind === "ok") done.push(itemId);
      else skipped.push({ itemId, message: r.message });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ itemId, message: err.message });
    }
  }
  if (done.length) await audit(user, { action: input.kind === "TEMP" ? "warehouse.temp_out" : "warehouse.final_out", entityType: "warehouse", data: { count: done.length } });
  return { done, skipped };
}
