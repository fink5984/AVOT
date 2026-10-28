import "server-only";
import { classifyCode } from "@avot/shared";
import { db } from "../db";
import type { UserPrincipal } from "../auth/principal";
import { catalogScope } from "../auth/houses";
import { findItemByCode } from "./inventory";
import { findLocationByCode } from "./warehouse";
import { locationLabel } from "./location-label";

const itemSummary = { id: true, inventoryNumber: true, title: true, author: true, photoStatus: true, physicalStatus: true, photoCount: true } as const;

export const LOT_CODE_PREFIX = "AVOT-LOT:";

/** Extracts a lot id from a scanned label (QR text, URL or raw "AVOT-LOT:<uuid>"). */
export function lotIdFromCode(q: string): string | null {
  const c = classifyCode(q);
  return c.type === "LOT" ? c.value : null;
}

/**
 * Global search box. A scanned or typed code opens its target directly:
 * book tag (ITM-000184 / registered barcode) → the book, shelf code → the
 * location, legacy catalog label (AVOT-LOT:<uuid>) → that lot.
 */
export async function globalSearch(user: UserPrincipal, raw: string) {
  const orgId = user.organizationId;
  const q = raw.trim();
  const empty = {
    items: [] as Awaited<ReturnType<typeof db.inventoryItem.findMany<{ select: typeof itemSummary }>>>,
    lots: [],
    catalogs: [],
    directLotId: null as string | null,
    directItemId: null as string | null,
    directLocationId: null as string | null,
    /** the shelf a scanned location code points to, with its human name */
    directLocation: null as { id: string; label: string } | null,
  };
  if (!q) return empty;
  const code = classifyCode(q);
  if (code.type === "LOT") {
    const lot = await db.lot.findFirst({ where: { id: code.value, organizationId: orgId, catalog: catalogScope(user) }, select: { id: true } });
    return { ...empty, directLotId: lot?.id ?? null };
  }
  if (code.type === "LOCATION") {
    const loc = await findLocationByCode(orgId, code.value);
    return { ...empty, directLocationId: loc?.id ?? null, directLocation: loc ? { id: loc.id, label: locationLabel(loc) } : null };
  }
  if (code.type === "ITEM" || /^[\x21-\x7e]{4,64}$/.test(q)) {
    const item = await findItemByCode(orgId, q);
    if (item) {
      // the match is also a result: the box must show the book, never "nothing found"
      const summary = await db.inventoryItem.findUnique({ where: { id: item.id }, select: itemSummary });
      return { ...empty, directItemId: item.id, items: summary ? [summary] : [] };
    }
  }
  // "3/37" or "3-37" → catalog 3, lot 37
  const pair = q.match(/^(\S+)\s*[/\-]\s*(\d+)$/);
  const asNumber = /^\d+$/.test(q) ? Number(q) : undefined;

  const [items, lots, catalogs] = await Promise.all([
    db.inventoryItem.findMany({
      where: {
        organizationId: orgId,
        deletionRequestedAt: null,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { author: { contains: q, mode: "insensitive" } },
          { inventoryNumber: { contains: q.toUpperCase() } },
          { barcode: { contains: q, mode: "insensitive" } },
          { aliases: { some: { alias: { contains: q.toUpperCase() } } } },
          ...(asNumber !== undefined && q.length <= 7 ? [{ serial: BigInt(q) }] : []),
        ],
      },
      select: itemSummary,
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    db.lot.findMany({
      where: {
        organizationId: orgId,
        catalog: catalogScope(user),
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { subtitle: { contains: q, mode: "insensitive" } },
          { author: { contains: q, mode: "insensitive" } },
          { printPlace: { contains: q, mode: "insensitive" } },
          { printYear: { contains: q, mode: "insensitive" } },
          { shortDescription: { contains: q, mode: "insensitive" } },
          ...(asNumber !== undefined ? [{ lotNumber: asNumber }] : []),
          ...(pair ? [{ lotNumber: Number(pair[2]), catalog: { number: pair[1]! } }] : []),
        ],
      },
      include: { catalog: { select: { id: true, number: true, name: true, auctionHouse: { select: { name: true, slug: true } } } } },
      orderBy: [{ catalog: { updatedAt: "desc" } }, { lotNumber: "asc" }],
      take: 50,
    }),
    db.catalog.findMany({
      where: {
        organizationId: orgId,
        ...catalogScope(user),
        OR: [{ name: { contains: q, mode: "insensitive" } }, { number: { contains: q } }, { description: { contains: q, mode: "insensitive" } }],
      },
      include: { auctionHouse: { select: { name: true } } },
      take: 10,
    }),
  ]);
  return { ...empty, items, lots, catalogs };
}
