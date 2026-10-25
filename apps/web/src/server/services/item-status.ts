import "server-only";
import type { CommercialStatus, LotStatus, PhysicalStatus } from "@avot/shared";
import type { Tx } from "../db";
import type { Principal } from "../auth/principal";

type Dimension = "PHOTO" | "PHYSICAL" | "COMMERCIAL";
type StatusOf<D extends Dimension> = D extends "PHOTO" ? LotStatus : D extends "PHYSICAL" ? PhysicalStatus : CommercialStatus;

const FIELD = { PHOTO: "photoStatus", PHYSICAL: "physicalStatus", COMMERCIAL: "commercialStatus" } as const;

export interface StatusChangeRef {
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
}

/**
 * The one place an item's status changes. Three independent dimensions —
 * photography, physical (warehouse) and commercial — each transition is
 * recorded in InventoryStatusEvent. Photo status is mirrored onto the item's
 * lots (Lot.status) in the same transaction so catalog lists stay correct.
 * Returns false when the item already had that status (nothing recorded).
 */
export async function changeStatus<D extends Dimension>(
  tx: Tx,
  principal: Principal,
  itemId: string,
  dimension: D,
  to: StatusOf<D>,
  ref: StatusChangeRef = {},
): Promise<boolean> {
  const field = FIELD[dimension];
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId }, select: { [field]: true, organizationId: true } as never });
  const from = (item as Record<string, string>)[field];
  if (from === to) return false;
  await tx.inventoryItem.update({
    where: { id: itemId },
    data: {
      [field]: to,
      ...(dimension === "PHOTO" ? { photoCompletedAt: to === "COMPLETED" ? new Date() : null } : {}),
    } as never,
  });
  if (dimension === "PHOTO") {
    await tx.lot.updateMany({
      where: { inventoryItemId: itemId },
      data: { status: to as LotStatus, completedAt: to === "COMPLETED" ? new Date() : null },
    });
  }
  await tx.inventoryStatusEvent.create({
    data: {
      organizationId: (item as { organizationId: string }).organizationId,
      inventoryItemId: itemId,
      dimension,
      fromStatus: from,
      toStatus: to,
      userId: principal.kind === "user" ? principal.userId : null,
      reason: ref.reason ?? null,
      refType: ref.refType ?? null,
      refId: ref.refId ?? null,
    },
  });
  return true;
}

/** Physical statuses from which a book may be (re)placed on a shelf by a scan. */
export const STORABLE: readonly PhysicalStatus[] = ["AWAITING_STORAGE", "IN_STORAGE", "MISSING", "AWAITING_PICK"];

/** Explains why a physical status blocks shelving, in Hebrew; null when allowed. */
export function storeBlockedReason(status: PhysicalStatus): string | null {
  if (status === "SHIPPED") return "הספר כבר נשלח — לא ניתן לשייך אותו למדף";
  if (status === "PICKED" || status === "PACKED") return "הספר לוקט לקראת משלוח — בטלו את משימת הליקוט לפני החזרה למדף";
  return null;
}
