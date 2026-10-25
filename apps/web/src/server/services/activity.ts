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
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export function describeData(action: string, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (action === "photo.captured" && typeof d.category === "string") return he.category[d.category as keyof typeof he.category] ?? null;
  if (action === "lot.status_changed" && typeof d.status === "string") return he.lotStatus[d.status as keyof typeof he.lotStatus] ?? null;
  if (action === "photo.moved_category" && typeof d.toCategory === "string") return `אל ${he.category[d.toCategory as keyof typeof he.category]}`;
  if ((action === "lot.created" || action === "lot.deleted") && d.title) return `${d.lotNumber ?? ""} · ${d.title}`;
  if (action.startsWith("catalog.") && d.name) return String(d.name);
  if (action === "lot.imported_csv" && d.count) return `${d.count} פריטים`;
  if (action === "user.invited" && d.email) return String(d.email);
  if (action === "inventory.created" && d.inventoryNumber) return `${d.inventoryNumber} · ${d.title ?? ""}`;
  if (action === "lot.assigned" && d.catalogNumber) return `קטלוג ${d.catalogNumber} · פריט ${d.lotNumber}`;
  if (action === "lot.commercial_status" && typeof d.to === "string") return he.commercialStatus[d.to as keyof typeof he.commercialStatus] ?? null;
  return null;
}
