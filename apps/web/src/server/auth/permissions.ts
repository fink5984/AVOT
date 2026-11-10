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
  /** the photographer's notes on a book: a focused permission, so a photographer can write them without being able to edit the book */
  "photographerNotes.edit": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  /** permanent deletion of books (database rows and every stored file) */
  "inventory.delete": ["ADMIN"],
  /** change a book's shelf from inventory / catalog screens (movement history is always written) */
  "inventory.relocate": ["ADMIN", "EDITOR", "WAREHOUSE"],
  /** assign a book to a catalog, end / change an assignment */
  "catalog.assign": ["ADMIN", "EDITOR"],
  /** offered / sold / unsold / withdrawn */
  "commercial.edit": ["ADMIN", "EDITOR"],
  /** consignors page, cards and the picker (contact details are not shown to warehouse staff) */
  "consignor.view": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "VIEWER"],
  /** a new consignor can be created while receiving a book (also from the capture screen) */
  "consignor.create": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  /** edit details, archive, delete an empty consignor */
  "consignor.manage": ["ADMIN", "EDITOR"],
  "label.print": ["ADMIN", "EDITOR", "PHOTOGRAPHER", "WAREHOUSE"],
  /** start the AI analysis of a book (first run, or a retry after a failed first run) */
  "ai.analyze": ["ADMIN", "EDITOR", "PHOTOGRAPHER"],
  /** a manager who may approve (with their password) a re-analysis that replaces the previous AI details */
  "ai.reanalyze.approve": ["ADMIN"],
  /** restore the details an AI run replaced */
  "ai.restore": ["ADMIN", "EDITOR"],
  /** apply (all or chosen fields of) a saved AI run to the item, and compare two runs */
  "ai.apply": ["ADMIN", "EDITOR"],
  /** the "הגדרות AI" tab: provider, model, prompts, style examples */
  "ai.settings": ["ADMIN"],
  /** "מצב פרטי הפריט": start the human review, approve the details */
  "item.review": ["ADMIN", "EDITOR"],
  /** "סיום בדיקה ואישור": the final approval of a book's details. Admins by role; anyone else only when granted (User.extraPermissions) */
  "item.review.approve": ["ADMIN"],
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

/** Permissions an admin may grant to an individual user on top of their role (user management screen). */
export const GRANTABLE_PERMISSIONS = ["item.review.approve"] as const satisfies readonly Permission[];
export const GRANTABLE_LABEL: Record<(typeof GRANTABLE_PERMISSIONS)[number], string> = {
  "item.review.approve": "אישור סופי של פרטי ספרים",
};

/** The role's permissions plus the ones granted to this person. Use it for every check that can be granted individually. */
export function canUser(user: { role: Role; extraPermissions?: readonly string[] }, permission: Permission): boolean {
  return can(user.role, permission) || (user.extraPermissions ?? []).includes(permission);
}
