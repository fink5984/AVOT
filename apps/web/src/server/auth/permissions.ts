import type { Role } from "@avot/shared";
import { WAREHOUSE_VIEW_ROLES } from "@/lib/nav-roles";

/**
 * Permission matrix. Checked on the server for every request; the UI only uses
 * it to decide which controls to render.
 *
 * Roles: ADMIN (everything), EDITOR (auction-house manager — catalogs,
 * inventory, assignments), PHOTOGRAPHER (photography only), WAREHOUSE
 * (warehouse / handheld only), VIEWER (read-only). Auction-house scoping
 * (UserHouseAccess) is applied on top of this matrix — see auth/houses.ts.
 */
export const PERMISSIONS = {
  "catalog.view": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "VIEWER"],
  "catalog.edit": ["ADMIN", "EDITOR"],
  "catalog.delete": ["ADMIN"],
  "lot.edit": ["ADMIN", "EDITOR"],
  "lot.create": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "lot.status": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "photo.capture": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "photo.organize": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "photo.delete": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "photo.download": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "VIEWER"],
  "export.create": ["ADMIN", "EDITOR"],
  "report.view": ["ADMIN", "EDITOR"],
  "user.manage": ["ADMIN"],
  "device.manage": ["ADMIN"],
  "audit.view": ["ADMIN"],
  "settings.manage": ["ADMIN"],
  "simulator.use": ["ADMIN"],

  /* inventory */
  "inventory.view": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "WAREHOUSE", "VIEWER"],
  "inventory.create": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  "inventory.edit": ["ADMIN", "EDITOR"],
  "inventory.import": ["ADMIN", "EDITOR"],
  /** permanent deletion of books (database rows and every stored file) */
  "inventory.delete": ["ADMIN"],
  /** change a book's shelf from inventory / catalog screens (movement history is always written) */
  "inventory.relocate": ["ADMIN", "EDITOR", "WAREHOUSE"],
  /** assign a book to a catalog, end / change an assignment */
  "catalog.assign": ["ADMIN", "EDITOR"],
  /** offered / sold / unsold / withdrawn */
  "commercial.edit": ["ADMIN", "EDITOR"],
  "label.print": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "WAREHOUSE"],
  "house.manage": ["ADMIN"],
  /** printers, print queue administration, test prints, re-print of any job */
  "print.manage": ["ADMIN"],

  /* warehouse */
  "warehouse.view": WAREHOUSE_VIEW_ROLES,
  /** handheld: store, transfer, pick, count scans */
  "warehouse.operate": ["ADMIN", "WAREHOUSE"],
  /** zones / shelves / locations, approving stock counts, resolving scan conflicts */
  "warehouse.manage": ["ADMIN"],
  /** create / cancel pick tasks */
  "pick.manage": ["ADMIN", "EDITOR"],
  /** packed / shipped */
  "pick.fulfil": ["ADMIN", "WAREHOUSE"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
