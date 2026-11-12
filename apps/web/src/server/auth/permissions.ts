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

  /* starting prices, sales, customers, payments, shipments */
  /** the lot's starting price (USD) in the catalog table and the lot page */
  "lot.price.edit": ["ADMIN", "EDITOR"],
  /** the customers page and a customer's details, addresses and purchases (warehouse staff do not get personal details) */
  "customer.view": ["ADMIN", "EDITOR"],
  "customer.edit": ["ADMIN", "EDITOR"],
  /** the "נמכרו" page: what sold, to whom, prices, payment state */
  "sales.view": ["ADMIN", "EDITOR", "VIEWER"],
  /** upload a sale-results file, review the preview, commit it */
  "sales.import": ["ADMIN", "EDITOR"],
  /** correct a recorded result (buyer, hammer price), record a late sale */
  "sales.correct": ["ADMIN", "EDITOR"],
  /** record, void payments */
  "payment.manage": ["ADMIN", "EDITOR"],
  /** release a sold lot to the picking queue. Releasing BEFORE payment is a separate, individually grantable permission */
  "pick.release": ["ADMIN", "EDITOR"],
  "pick.release.unpaid": ["ADMIN"],
  /** build shipments, add / remove books, pack */
  "shipment.prepare": ["ADMIN", "EDITOR", "WAREHOUSE"],
  /** send a shipment that leaves part of a customer's books behind */
  "shipment.partial": ["ADMIN", "EDITOR"],
  /** shipped / delivered / cancel / return */
  "shipment.status": ["ADMIN", "EDITOR", "WAREHOUSE"],
  /** cancel a purchase (the sale is kept as history) */
  "sale.cancel": ["ADMIN"],
  /** end a sale: decide the unsold lots, close results */
  "sale.finish": ["ADMIN", "EDITOR"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Permissions an admin may grant to an individual user on top of their role (user management screen). */
export const GRANTABLE_PERMISSIONS = ["item.review.approve", "pick.release.unpaid", "shipment.partial"] as const satisfies readonly Permission[];
export const GRANTABLE_LABEL: Record<(typeof GRANTABLE_PERMISSIONS)[number], string> = {
  "item.review.approve": "אישור סופי של פרטי ספרים",
  "pick.release.unpaid": "שחרור לליקוט לפני תשלום",
  "shipment.partial": "אישור משלוח חלקי",
};

/** The role's permissions plus the ones granted to this person. Use it for every check that can be granted individually. */
export function canUser(user: { role: Role; extraPermissions?: readonly string[] }, permission: Permission): boolean {
  return can(user.role, permission) || (user.extraPermissions ?? []).includes(permission);
}
