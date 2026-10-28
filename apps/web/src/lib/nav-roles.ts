import type { Role } from "@avot/shared";

/** Who may see the warehouse and use the handheld. One list for the sidebar and for the server permission. */
export const WAREHOUSE_VIEW_ROLES: Role[] = ["ADMIN", "EDITOR", "WAREHOUSE", "VIEWER"];
