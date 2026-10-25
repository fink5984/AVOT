import "server-only";

/** Prisma include that loads a location's full hierarchy for labels. */
export const locationInclude = { shelf: { include: { zone: { include: { warehouse: true } } } } } as const;

export interface LocationWithHierarchy {
  code: string;
  cell: string;
  shelf: { code: string; zone: { code: string; name: string; warehouse: { name: string; isDefault: boolean } } };
}

/** "מחסן ראשי › אזור A › מדף 03 › תא 02" — the warehouse is omitted for the default one. */
export function locationLabel(l: LocationWithHierarchy): string {
  const z = l.shelf.zone;
  return [...(z.warehouse.isDefault ? [] : [z.warehouse.name]), z.name || `אזור ${z.code}`, `מדף ${l.shelf.code}`, `תא ${l.cell}`].join(" › ");
}
