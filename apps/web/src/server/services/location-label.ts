import "server-only";

/** Prisma include that loads a location's full hierarchy for labels. */
export const locationInclude = { shelf: { include: { zone: { include: { warehouse: true } } } } } as const;

export interface LocationWithHierarchy {
  code: string;
  cell: string;
  shelf: { code: string; zone: { code: string; name: string; warehouse: { name: string; isDefault: boolean } } };
}

const plain = (code: string) => (/^\d+$/.test(code) ? String(Number(code)) : code);

/**
 * The human form of a place: "מחסן 1 · עמודה 5 · מדף 5" (the cell is added only when a shelf was split into cells).
 * The technical code (LOC-W1-C5-05-01) is shown separately, small, where it is needed.
 */
export function locationLabel(l: LocationWithHierarchy): string {
  const z = l.shelf.zone;
  const cell = l.cell !== "01" && l.cell !== "1" ? [`תא ${plain(l.cell)}`] : [];
  return [z.warehouse.name, z.name || `עמודה ${plain(z.code)}`, `מדף ${plain(l.shelf.code)}`, ...cell].join(" · ");
}
