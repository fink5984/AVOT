/** Field names of a sale-results file and the mapping that links columns to them. Client-safe (no file-reading libraries). */

export const RESULT_FIELDS = [
  "lotNumber",
  "externalLotId",
  "outcome",
  "hammerPrice",
  "bidderNumber",
  "buyerId",
  "buyerName",
  "email",
  "phone",
  "address",
  "orderNumber",
  "transactionId",
  "buyerPremium",
  "tax",
] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export const FIELD_LABEL: Record<ResultField, string> = {
  lotNumber: "מספר לוט",
  externalLotId: "מזהה לוט חיצוני",
  outcome: "מצב מכירה",
  hammerPrice: "מחיר פטיש",
  bidderNumber: "מספר מציע",
  buyerId: "מזהה קונה קבוע",
  buyerName: "שם קונה",
  email: "אימייל",
  phone: "טלפון",
  address: "כתובת",
  orderNumber: "מספר הזמנה",
  transactionId: "מזהה עסקה חיצונית",
  buyerPremium: "עמלת קונה",
  tax: "מס",
};

export interface ImportMapping {
  /** field → the header of the column that holds it */
  results: Partial<Record<ResultField, string>>;
  /** second file with the buyers' details: how its rows link to the result rows, and which column holds what */
  buyers?: { key: "bidderNumber" | "buyerId"; keyHeader: string; columns: Partial<Record<ResultField, string>> };
  /** words (lower case) meaning sold / not sold in the outcome column, added to the built-in ones */
  soldWords?: string[];
  unsoldWords?: string[];
}

