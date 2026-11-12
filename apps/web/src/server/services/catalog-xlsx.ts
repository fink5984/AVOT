import "server-only";
import ExcelJS from "exceljs";
import { db } from "../db";
import { notFound } from "../errors";
import type { UserPrincipal } from "../auth/principal";
import { assertHouse } from "../auth/houses";
import { DEFAULT_EXPORT_PROFILE, EXPORT_PROFILES, type ExportLotRow } from "../bidspirit/export-mapping";
import { money } from "./lot-pricing";
import { safeSegment } from "./filenames";

/**
 * "ייצוא קטלוג ל-Excel": one row per ACTIVE lot of the catalog (a combined lot is one row; lots that left the catalog
 * are history and are not exported). It ignores every filter of the table on screen. A missing price is an empty cell.
 */
export async function catalogLotRows(catalogId: string): Promise<ExportLotRow[]> {
  const lots = await db.lot.findMany({
    where: { catalogId, assignmentStatus: "ACTIVE", mergedIntoLotId: null },
    orderBy: { lotNumber: "asc" },
    include: {
      members: { where: { removedAt: null }, orderBy: { sortOrder: "asc" }, select: { item: { select: { inventoryNumber: true, consignor: { select: { name: true } } } } } },
      item: { select: { inventoryNumber: true, consignor: { select: { name: true } } } },
    },
  });
  return lots.map((l) => {
    const books = l.members.length ? l.members.map((m) => m.item) : [l.item];
    return {
      lotNumber: l.lotNumber,
      startingPrice: money(l.startingPrice),
      title: l.title,
      subtitle: l.subtitle,
      description: l.description ?? l.shortDescription,
      author: l.author,
      printYear: l.printYear,
      printPlace: l.printPlace,
      bookCount: books.length,
      inventoryNumbers: books.map((b) => b.inventoryNumber).join(" | "),
      externalRef: l.externalRef,
      consignor: books[0]?.consignor?.name ?? null,
    };
  });
}

export async function buildCatalogWorkbook(user: UserPrincipal, catalogId: string, profileId: string = DEFAULT_EXPORT_PROFILE) {
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId }, include: { auctionHouse: true } });
  if (!catalog) throw notFound("הקטלוג");
  assertHouse(user, catalog.auctionHouseId);
  const profile = EXPORT_PROFILES[profileId] ?? EXPORT_PROFILES[DEFAULT_EXPORT_PROFILE]!;
  const rows = await catalogLotRows(catalogId);

  const wb = new ExcelJS.Workbook();
  wb.creator = "AVOT Studio";
  const ws = wb.addWorksheet("Lots");
  ws.addRow(profile.columns.map((c) => c.header));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow(
      profile.columns.map((c) => {
        const v = c.value(r);
        if (v === null || v === "") return null;
        return c.type === "money" ? Number(v) : v;
      }),
    );
  }
  profile.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(60, Math.max(c.header.length + 2, c.type === "text" || !c.type ? 40 : 14));
    if (c.type === "money") col.numFmt = '"$"#,##0.00';
  });

  const missing = rows.filter((r) => r.startingPrice === null).length;
  const notes = wb.addWorksheet("AVOT");
  notes.addRows([
    ["קטלוג", `${catalog.number} · ${catalog.name}`],
    ["בית מכירות", catalog.auctionHouse.name],
    ["לוטים בקובץ", rows.length],
    ["לוטים ללא מחיר פתיחה", missing],
    ["פרופיל ייצוא", profile.label],
    ["נבדק מול Bidspirit", profile.verifiedWithBidspirit ? "כן" : "לא"],
    ["הערת תאימות", profile.limitation],
    ["הופק", new Date().toISOString()],
  ]);
  notes.getColumn(1).width = 26;
  notes.getColumn(2).width = 100;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `Catalog-${safeSegment(catalog.number)}-bidspirit.xlsx`, lots: rows.length, missingPrices: missing, profile: { id: profile.id, verified: profile.verifiedWithBidspirit, limitation: profile.limitation } };
}
