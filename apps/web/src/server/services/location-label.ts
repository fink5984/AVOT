import "server-only";
import { formatLocationLabel } from "@avot/shared";

/** Prisma include that loads a location's full hierarchy for labels. */
export const locationInclude = { shelf: { include: { zone: { include: { warehouse: true } } } } } as const;

export interface LocationWithHierarchy {
  shelf: { code: string; zone: { code: string; name: string; warehouse: { name: string } } };
}

/**
 * The human form of a place: "מחסן 1 · עמודה 5 · מדף 5". Built from the hierarchy (never by parsing a code); the
 * technical code is only the barcode value. Same formatter as the client (`formatLocationLabel` in @avot/shared).
 */
export function locationLabel(l: LocationWithHierarchy): string {
  const z = l.shelf.zone;
  return formatLocationLabel({ warehouseName: z.warehouse.name, zoneName: z.name, zoneCode: z.code, shelfCode: l.shelf.code });
}
