/**
 * The column layer of the catalog Excel export. AVOT has NO verified, current Bidspirit import template yet: the
 * names below come from earlier public sources (itemIndex, startPrice, mainLangName, mainLangDesc, mainLangAuthor,
 * estimatedPrice) and are NOT confirmed against Bidspirit's current official template. When the official template
 * arrives, add a new profile here (header names, order, extra columns) and make it the default - nothing else changes.
 */

/** the values AVOT can offer for a lot row */
export interface ExportLotRow {
  lotNumber: number;
  /** USD, "150.00", or null (exported as an empty cell, never 0) */
  startingPrice: string | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  author: string | null;
  printYear: string | null;
  printPlace: string | null;
  bookCount: number;
  inventoryNumbers: string;
  /** external id of the lot in Bidspirit, when known */
  externalRef: string | null;
  consignor: string | null;
}

export type ExportColumn = {
  header: string;
  /** what AVOT puts in the cell */
  value: (r: ExportLotRow) => string | number | null;
  type?: "number" | "money" | "text";
};

export interface ExportProfile {
  id: string;
  label: string;
  /** false until a real file made with this profile was accepted by Bidspirit */
  verifiedWithBidspirit: boolean;
  /** shown to the person next to the download and written in the file's notes sheet */
  limitation: string;
  columns: ExportColumn[];
}

export const PUBLIC_LEGACY_PROFILE: ExportProfile = {
  id: "public-legacy",
  label: "תבנית ציבורית ישנה (לא אומתה מול Bidspirit)",
  verifiedWithBidspirit: false,
  limitation:
    "שמות העמודות נלקחו ממקורות ציבוריים קודמים ואינם תבנית הייבוא הרשמית והעדכנית של Bidspirit. הקובץ לא נבדק בהצלחה מול Bidspirit. כשתתקבל התבנית הרשמית יש לעדכן את שכבת המיפוי.",
  columns: [
    { header: "itemIndex", value: (r) => r.lotNumber, type: "number" },
    { header: "startPrice", value: (r) => r.startingPrice, type: "money" },
    { header: "mainLangName", value: (r) => r.title },
    { header: "mainLangDesc", value: (r) => r.description },
    { header: "mainLangAuthor", value: (r) => r.author },
  ],
};

export const EXPORT_PROFILES: Record<string, ExportProfile> = { [PUBLIC_LEGACY_PROFILE.id]: PUBLIC_LEGACY_PROFILE };
export const DEFAULT_EXPORT_PROFILE = PUBLIC_LEGACY_PROFILE.id;
