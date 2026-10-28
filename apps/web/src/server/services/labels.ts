import "server-only";
import { LABEL_STOCKS } from "@avot/shared";
import { db } from "../db";
import { locationInclude, locationLabel } from "./location-label";

/*
 * Label lookups for the manual print page. Antique books never get adhesive labels on the binding: the book
 * tag goes on the protective sleeve / box / a hanging tag (see the warning on the print screen).
 * The DESIGN of a label (book / shelf / column) lives in exactly one place: label-layout.ts in the shared package,
 * rendered by server/labels/*. Nothing in this file draws or lays out anything.
 */

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}
export const LABEL_SIZES: Record<string, LabelSize> = LABEL_STOCKS;
export function labelSize(key: string | null | undefined): LabelSize {
  return LABEL_SIZES[key ?? ""] ?? LABEL_SIZES["50x25"]!;
}

export interface BookLabel {
  id: string;
  code: string;
  title: string;
  subtitle: string | null;
}
export interface LocationLabel {
  id: string;
  code: string;
  zone: string;
  shelf: string;
  label: string;
}

export async function bookLabels(orgId: string, ids: string[]): Promise<BookLabel[]> {
  const items = await db.inventoryItem.findMany({ where: { organizationId: orgId, id: { in: ids } }, orderBy: { serial: "asc" } });
  return items.map((i) => ({ id: i.id, code: i.barcode, title: i.title, subtitle: i.author }));
}

export async function locationLabels(orgId: string, ids: string[]): Promise<LocationLabel[]> {
  const locs = await db.storageLocation.findMany({ where: { organizationId: orgId, id: { in: ids } }, include: locationInclude, orderBy: { sortKey: "asc" } });
  return locs.map((l) => ({ id: l.id, code: l.code, zone: l.shelf.zone.name, shelf: l.shelf.code, label: locationLabel(l) }));
}
