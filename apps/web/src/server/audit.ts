import "server-only";
import type { Prisma } from "@prisma/client";
import { db, type Tx } from "./db";
import type { Principal } from "./auth/principal";

export interface AuditEntry {
  action: string;
  entityType:
    | "catalog"
    | "lot"
    | "asset"
    | "user"
    | "device"
    | "export"
    | "settings"
    | "session"
    | "inventory"
    | "house"
    | "warehouse"
    | "location"
    | "pick"
    | "count"
    | "scan";
  entityId?: string | null;
  lotId?: string | null;
  /** the physical book this entry belongs to — drives the book's full history */
  inventoryItemId?: string | null;
  data?: Prisma.InputJsonValue;
}

export async function audit(principal: Principal, entry: AuditEntry, tx: Tx = db) {
  await tx.auditLog.create({
    data: {
      organizationId: principal.organizationId,
      userId: principal.kind === "user" ? principal.userId : null,
      deviceId: principal.kind === "device" ? principal.deviceId : null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      lotId: entry.lotId ?? null,
      inventoryItemId: entry.inventoryItemId ?? null,
      data: entry.data,
    },
  });
}
