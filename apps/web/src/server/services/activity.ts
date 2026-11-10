import "server-only";
import { he } from "@/i18n/he";

const ACTION_LABEL: Record<string, string> = {
  "photo.captured": "צילם תמונה",
  "photo.deleted": "העביר תמונה לסל המחזור",
  "photo.restored": "שחזר תמונה",
  "photo.purged": "תמונה נמחקה לצמיתות (תום תקופת השמירה)",
  "photo.moved_lot": "העביר תמונה לספר אחר",
  "photo.moved_category": "העביר תמונה לקטגוריה אחרת",
  "photo.reordered": "שינה סדר תמונות",
  "photo.set_primary": "הגדיר תמונה ראשית",
  "photo.updated": "עדכן פרטי תמונה",
  "lot.created": "יצר פריט",
  "lot.updated": "עדכן פרטי פריט",
  "lot.status_changed": "שינה סטטוס פריט",
  "lot.deleted": "מחק פריט",
  "lot.moved_catalog": "העביר פריט לקטלוג אחר",
  "lot.imported_csv": "ייבא פריטים מ-CSV",
  "lot.category_note": "עדכן סימון קטגוריה",
  "lot.reordered": "שינה סדר פריטים",
  "lot.merged": "איחד פריטים ללוט משולב",
  "lot.joined": "הספר צורף ללוט משולב",
  "lot.books_added": "הוסיף ספרים ללוט משולב",
  "lot.book_removed": "הסיר ספר מלוט משולב",
  "lot.dissolved": "פירק לוט משולב",
  "lot.reactivated": "פריט שאוחד חזר להיות פריט נפרד",
  "lot.books_reordered": "שינה סדר ספרים בלוט משולב",
  "lot.ai_generated": "יצר הצעת תיאור משותף ב-AI",
  "lot.ai_applied": "החיל תיאור משותף ב-AI על הלוט",
  "lot.ai_discarded": "דחה הצעת תיאור משותף",
  "lot.description_confirmed": "אישר שהתיאור המשותף עדיין מתאים",
  "catalog.created": "יצר קטלוג",
  "catalog.updated": "עדכן קטלוג",
  "catalog.duplicated": "שכפל מבנה קטלוג",
  "catalog.deleted": "מחק קטלוג",
  "export.requested": "ביקש ייצוא",
  "user.invited": "הזמין משתמש",
  "user.updated": "עדכן משתמש",
  "user.invite_accepted": "הצטרף למערכת",
  "user.password_reset": "איפס סיסמה",
  "user.reset_link_created": "הפיק קישור איפוס סיסמה",
  "device.paired": "צימד עמדת צילום",
  "device.revoked": "ביטל עמדת צילום",
  "device.updated": "עדכן עמדת צילום",
  "device.pairing_code_created": "הפיק קוד צימוד",
  "device.control_token_issued": "התחבר לעמדת צילום",
  "session.login": "התחבר",
  "inventory.created": "קלט ספר למלאי",
  "inventory.updated": "עדכן פרטי ספר",
  "inventory.migrated": "ספר מלאי נוצר במיגרציה מפריט קטלוג",
  "inventory.photo_status": "שינה סטטוס צילום",
  "inventory.imported_csv": "ייבא ספרים למלאי מ-CSV",
  "lot.assigned": "שייך לקטלוג",
  "lot.commercial_status": "שינה מצב מסחרי",
  "catalog.closed": "סיים קטלוג",
  "photo.reordered_lot": "שינה סדר תמונות לקטלוג",
  "photo.set_primary_lot": "הגדיר תמונה ראשית לקטלוג",
  "photo.lot_hidden": "הסתיר תמונה בקטלוג",
  "photo.lot_shown": "הציג תמונה בקטלוג",
  "photo.lot_display_reset": "איפס תצוגת תמונות בקטלוג",
  "pick.created": "נוצרה משימת ליקוט",
  "pick.packed": "סימן נארז",
  "pick.shipped": "סימן נשלח",
  "pick.cancelled": "ביטל משימת ליקוט",
  "count.started": "התחיל ספירת מלאי",
  "count.submitted": "הגיש ספירת מלאי",
  "count.approved": "אישר פערי ספירה",
  "count.cancelled": "ביטל ספירת מלאי",
  "scan.conflict": "סריקה מאוחרת סותרת הועברה לבדיקה",
  "scan.conflict_applied": "אישר סריקה סותרת",
  "scan.conflict_dismissed": "דחה סריקה סותרת",
  "warehouse.created": "יצר מחסן",
  "warehouse.zone_created": "יצר אזור במחסן",
  "warehouse.shelf_created": "יצר מדף",
  "warehouse.locations_created": "יצר מיקומי אחסון",
  "warehouse.location_updated": "עדכן מיקום אחסון",
  "warehouse.item_moved": "תיקן מיקום ספר",
  "house.updated": "עדכן הגדרות בית מכירות",
  "inventory.consignor_changed": "שינה את המפקיד של הספר",
  "inventory.photographer_notes": "עדכן הערות מצלם",
  "inventory.capture_finished": "סיים צילום ספר",
  "consignor.created": "יצר מפקיד",
  "consignor.updated": "עדכן פרטי מפקיד",
  "consignor.archived": "העביר מפקיד לארכיון",
  "consignor.restored": "שחזר מפקיד מהארכיון",
  "consignor.deleted": "מחק מפקיד",
  "ai.requested": "הפעיל ניתוח AI",
  "ai.reanalysis_approved": "ניתוח AI חוזר אושר על ידי מנהל",
  "ai.reanalysis_denied": "אימות מנהל לניתוח AI חוזר נכשל",
  "ai.completed": "ניתוח AI הושלם",
  "ai.failed": "ניתוח AI נכשל",
  "ai.restored": "שחזר ערכים מלפני ניתוח AI",
  "ai.rewrite": "ביקש שכתוב של התיאור הקטלוגי ב-AI",
  "item_review.started": "התחיל בדיקת פרטי הפריט",
  "item_review.approved": "אישר את פרטי הפריט",
  "item_review.invalidated": "אישור הפרטים בוטל עקב שינוי מהותי",
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

const EDIT_FIELD: Record<string, string> = {
  title: "שם הספר",
  subtitle: "כותרת משנה",
  author: "מחבר",
  printPlace: "מקום דפוס",
  printYear: "שנת דפוס",
  publisher: "מדפיס / הוצאה",
  itemType: "סוג הפריט",
  edition: "מהדורה",
  extent: "היקף",
  bibliographicNotes: "פרטים ביבליוגרפיים",
  conditionNotes: "מצב העותק",
  internalNotes: "הערות פנימיות",
  catalogHeadline: "כותרת קטלוגית",
  catalogDescription: "תיאור קטלוגי",
  heightMm: "מידות",
  widthMm: "מידות",
  depthMm: "מידות",
  sizeCategory: "קטגוריית גודל",
  barcode: "ברקוד",
  textFormat: "עיצוב הטקסט",
};

export function describeData(action: string, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (action === "photo.captured" && typeof d.category === "string") return he.category[d.category as keyof typeof he.category] ?? null;
  if (action === "lot.status_changed" && typeof d.status === "string") return he.lotStatus[d.status as keyof typeof he.lotStatus] ?? null;
  if (action === "photo.moved_category" && typeof d.toCategory === "string") return `אל ${he.category[d.toCategory as keyof typeof he.category]}`;
  if ((action === "lot.created" || action === "lot.deleted") && d.title) return `${d.lotNumber ?? ""} · ${d.title}`;
  if (action.startsWith("catalog.") && d.name) return String(d.name);
  if (action === "lot.imported_csv" && d.count) return `${d.count} פריטים`;
  if (action === "user.invited" && d.email) return String(d.email);
  if (action === "inventory.consignor_changed" && typeof d.to === "string") return `${typeof d.from === "string" ? d.from : "ללא מפקיד"} ← ${d.to}`;
  if (action.startsWith("consignor.") && d.name) return String(d.name);
  if (action === "inventory.created" && d.inventoryNumber) return `${d.inventoryNumber} · ${d.title ?? ""}`;
  if (action === "lot.assigned" && d.catalogNumber) return `קטלוג ${d.catalogNumber} · פריט ${d.lotNumber}`;
  if ((action === "ai.requested" || action === "ai.completed") && typeof d.model === "string") return `${d.provider ?? ""} · ${d.model}${typeof d.costUsd === "number" ? ` · ${d.costUsd.toFixed(4)}` : ""}`;
  if (action === "ai.failed" && typeof d.error === "string") return d.error;
  if (action === "ai.reanalysis_denied" && typeof d.approverEmail === "string") return d.approverEmail;
  if ((action === "ai.restored" || action === "item_review.invalidated") && Array.isArray(d.fields)) return `${d.fields.length} שדות`;
  if (action === "inventory.updated") {
    const names = Object.keys(d).filter((k) => k !== "via").map((k) => EDIT_FIELD[k] ?? null).filter((x): x is string => !!x);
    const list = names.length ? `שונו: ${[...new Set(names)].join(", ")}` : null;
    return [list, d.via === "ai" ? "הוספת מידע ב-AI" : null].filter(Boolean).join(" · ") || null;
  }
  if (action === "lot.commercial_status" && typeof d.to === "string") return he.commercialStatus[d.to as keyof typeof he.commercialStatus] ?? null;
  return null;
}
