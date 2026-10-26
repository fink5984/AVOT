import type { BookSize, CatalogStatus, CommercialStatus, LotStatus, PhotoCategory, PhysicalStatus, PickStatus, Role, ScanMode } from "@avot/shared";

/**
 * Hebrew UI dictionary. Domain enums map to display names here; persisted keys
 * stay English. A future `en.ts` with the same shape enables English.
 */
export const he = {
  app: { name: "AVOT Studio", house: "אבות | AVOT" },
  category: {
    COVER: "כריכה",
    TITLE_PAGE: "שער",
    INTERIOR: "תמונות פנימיות",
    EXTERIOR: "תמונות חוץ",
  } satisfies Record<PhotoCategory, string>,
  categoryShort: {
    COVER: "כריכה",
    TITLE_PAGE: "שער",
    INTERIOR: "פנים",
    EXTERIOR: "חוץ",
  } satisfies Record<PhotoCategory, string>,
  lotStatus: {
    NOT_STARTED: "טרם התחיל",
    IN_PROGRESS: "בצילום",
    PENDING_REVIEW: "ממתין לבדיקה",
    COMPLETED: "הושלם",
    NEEDS_RESHOOT: "דורש צילום חוזר",
  } satisfies Record<LotStatus, string>,
  catalogStatus: {
    DRAFT: "בהכנה",
    ACTIVE: "פעיל",
    ARCHIVED: "בארכיון",
  } satisfies Record<CatalogStatus, string>,
  role: {
    ADMIN: "מנהל מערכת",
    EDITOR: "עורך",
    PHOTOGRAPHER: "צלם",
    WAREHOUSE: "מחסנאי",
    VIEWER: "צופה",
  } satisfies Record<Role, string>,
  /** photography status of a book (same keys as lotStatus) */
  photoStatus: {
    NOT_STARTED: "טרם צולם",
    IN_PROGRESS: "בצילום",
    PENDING_REVIEW: "ממתין לבדיקה",
    COMPLETED: "הושלם",
    NEEDS_RESHOOT: "דורש צילום חוזר",
  } satisfies Record<LotStatus, string>,
  physicalStatus: {
    AWAITING_STORAGE: "ממתין לאחסון",
    IN_STORAGE: "במחסן",
    AWAITING_PICK: "ממתין לליקוט",
    PICKED: "לוקט",
    PACKED: "נארז",
    SHIPPED: "נשלח",
    MISSING: "חסר / דורש בירור",
  } satisfies Record<PhysicalStatus, string>,
  commercialStatus: {
    UNASSIGNED: "לא משויך לקטלוג",
    ASSIGNED: "משויך לקטלוג",
    OFFERED: "הוצע למכירה",
    SOLD: "נמכר",
    UNSOLD: "לא נמכר",
    WITHDRAWN: "הוסר ממכירה",
  } satisfies Record<CommercialStatus, string>,
  bookSize: {
    UNKNOWN: "לא ידוע",
    SMALL: "קטן (עד 20 ס״מ)",
    MEDIUM: "בינוני (עד 30 ס״מ)",
    LARGE: "גדול (עד 42 ס״מ)",
    OVERSIZE: "חריג",
  } satisfies Record<BookSize, string>,
  scanMode: {
    STORE: "אחסון",
    TRANSFER: "העברה",
    FIND: "איתור",
    PICK: "ליקוט",
    COUNT: "ספירת מלאי",
  } satisfies Record<ScanMode, string>,
  pickStatus: {
    OPEN: "ממתין לליקוט",
    PICKED: "לוקט",
    PACKED: "נארז",
    SHIPPED: "נשלח",
    CANCELLED: "בוטל",
  } satisfies Record<PickStatus, string>,
  assignment: {
    ACTIVE: "שיוך פעיל",
    ENDED: "שיוך הסתיים",
  },
  uploadStage: {
    CAPTURING: "מצלם…",
    SAVED_LOCAL: "נשמר מקומית",
    QUEUED: "ממתין להעלאה",
    UPLOADING: "מעלה",
    VERIFIED: "נשמר בענן ואומת",
    FAILED: "הצילום נכשל",
    NEEDS_ATTENTION: "דורש טיפול",
  },
  serverUpload: {
    PENDING: "ממתין להעלאה",
    UPLOADING: "מעלה",
    VERIFIED: "נשמר בענן ואומת",
    FAILED: "ההעלאה נכשלה",
  },
  source: {
    WEBCAM: "מצלמת רשת",
    CANON_EDSDK: "Canon EDSDK",
    DIGICAMCONTROL: "digiCamControl",
    SIMULATOR: "סימולטור",
    IMPORT: "ייבוא",
  },
  common: {
    save: "שמירה",
    saving: "שומר…",
    saved: "נשמר",
    cancel: "ביטול",
    close: "סגירה",
    delete: "מחיקה",
    edit: "עריכה",
    create: "יצירה",
    search: "חיפוש",
    loading: "טוען…",
    retry: "ניסיון חוזר",
    confirm: "אישור",
    back: "חזרה",
    next: "הבא",
    previous: "הקודם",
    all: "הכול",
    actions: "פעולות",
    none: "—",
  },
} as const;

export type Dictionary = typeof he;
