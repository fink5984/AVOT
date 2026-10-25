# ארכיטקטורה

## רכיבים

```
┌──────────────────────── דפדפן (Chrome / Edge) ────────────────────────┐
│  מסך צילום אחד ── CameraDriver                                         │
│     ├─ WebcamDriver     getUserMedia + ImageCapture → Blob JPEG         │
│     ├─ SimulatorDriver  canvas (פיתוח / מנהל)                           │
│     └─ AgentDriver      HTTP ל-127.0.0.1:47800 (Canon / סימולטור Agent)  │
│  Outbox (IndexedDB, durability=strict) → Uploader (Web Locks, backoff)  │
└──────────────┬───────────────────────────────────────┬─────────────────┘
               │ HTTPS (cookie session)                │ http://127.0.0.1 (control token + lease)
               ▼                                       ▼
┌────────── AVOT Studio (Next.js, Railway) ─────┐   ┌──── Capture Agent (Windows) ─────┐
│ Route handlers  /api/*  (Zod, הרשאות, CSRF)   │◀──│ UploadQueue (Bearer device token) │
│ Services: catalogs, lots, captures, assets…  │   │ CaptureCoordinator ← ICameraDevice │
│ Job worker (DB-backed, SKIP LOCKED): ZIP,     │   │   ├ CanonCamera (EDSDK, STA thread)│
│   thumbnails, trash purge                     │   │   └ SimulatorCamera                │
│ Storage: S3 / R2  (local disk בפיתוח בלבד)    │   │ LocalStore (SQLite WAL, FULL sync) │
│ PostgreSQL (Prisma)                           │   │ LocalApi (Kestrel 127.0.0.1)       │
└───────────────────────────────────────────────┘   └────────────────────────────────────┘
```

## עקרון אמינות: אין "נשמר" לפני שזה באמת נשמר

כל צילום עובר שלבים נפרדים שמוצגים למשתמש בנפרד (`CAPTURE_STAGES`):

| שלב | משמעות | תנאי מעבר |
|---|---|---|
| `CAPTURING` | פקודת צילום נשלחה | — |
| `SAVED_LOCAL` | המקור שמור במחשב | IndexedDB commit (דפדפן) · fsync + rename + רשומת SQLite (Agent) |
| `QUEUED` / `UPLOADING` | בתור / בהעלאה | — |
| `VERIFIED` | נשמר בענן ואומת | השרת חישב SHA‑256 וגודל של הבתים שנשמרו בפועל והם זהים למוצהר |
| `FAILED` | הצילום עצמו נכשל | לא נשמר דבר; מוצג כך ואפשר לצלם שוב |
| `NEEDS_ATTENTION` | שמור מקומית, ההעלאה לא מצליחה | ממשיך לנסות כל 5 דק׳ ומוצג בדוחות |

- **שיוך קפוא:** מזהה צילום (UUID) נוצר בלחיצה, יחד עם הפריט והקטגוריה באותו רגע. ההקשר נשלח עם הבקשה ולעולם אינו נקרא מחדש. החלפת קטגוריה בזמן העברת קובץ אינה משנה את שיוכו (נבדק ב-E2E ובבדיקות Agent).
- **אידמפוטנטיות:** `POST /api/captures` לפי `(organizationId, captureId)` ייחודי; `PUT` לקובץ מאומת הוא no-op. ניסיון חוזר אחרי תשובה שאבדה / קריסה / ריענון — בטוח.
- **RAW+JPEG:** לחיצה אחת = `PhotoAsset` אחד עם שני `PhotoFile` (תפקידי PRIMARY ו-RAW).
- **מחיקה:** רכה בלבד (סל מחזור, ברירת מחדל 30 יום); מחיקה לצמיתות רק בעבודת רקע אחרי תקופת השמירה. קטלוג עם תמונות אינו ניתן למחיקה — רק לארכוב.
- **ניקוי מקומי:** בדפדפן — הרשומה נמחקת רק אחרי אימות השרת. ב-Agent — המקורות נשמרים לצמיתות כברירת מחדל (`LocalRetentionDays=0`); אם מוגדרת תקופה, נמחקים רק קבצים מאומתים שעברה עליהם.
- **התאוששות:** Agent בהפעלה סוגר צילומים תקועים לפי מה שקיים בדיסק; קבצים חלקיים מועברים ל-`_unassigned` (לא נמחקים). Outbox בדפדפן ממשיך מכל דף באתר.

## מודל נתונים

`Organization` (הפרדת ארגונים מוכנה ל-SaaS) ← `User`, `Catalog` ← `Lot` (מספר ייחודי בקטלוג, `sortOrder`, דרישות לכל קטגוריה) ← `PhotoAsset` ← `PhotoFile`. נוספים: `CaptureSession`, `Device`, `PairingCode`, `Job`, `AuditLog`, `Invite`, `PasswordResetToken`, `UserPreference`, `LotCategoryNote`. ראו `apps/web/prisma/schema.prisma`.

## תקשורת דפדפן ↔ Agent

- ה-Agent מאזין **רק** ל-`127.0.0.1` (לא לרשת המקומית). כותרת Host חייבת להיות `127.0.0.1`/`localhost` (הגנת DNS rebinding — 421 אחרת).
- CORS רק ל-Origin של השרת שאליו צומדה העמדה; תמיכה ב-Private Network Access preflight. Chrome/Edge מתייחסים ל-`http://127.0.0.1` כמקור מאובטח ולכן אין חסימת mixed content מאתר HTTPS. דפדפנים עדכניים עשויים להציג בקשת הרשאה "גישה לרשת המקומית" — יש לאשר פעם אחת.
- הרשאה: השרת מנפיק *control token* (HMAC-SHA256 עם סוד העמדה שנוצר בצימוד) לנושא: עמדה, משתמש, Origin, תוקף. ה-Agent מאמת אותו בלי חיבור לשרת. Lease אחד בכל רגע — משתמש אחר מקבל 409.
- Live View: ‏MJPEG מקומי (≤15fps) ישירות לדפדפן; לא נשלח לענן.
- אם בעתיד מדיניות דפדפן תחסום גישה ל-localhost, אותו UI יכול לרוץ בתוך מעטפת WebView2 ב-Agent (לא נבנתה בשלב זה — לא נדרשה בבדיקות).

## הרחבות עתידיות (תשתית קיימת, לא מומשו)

OCR ותיאורים (`Lot.shortDescription`, `PhotoAsset.exif/quality`), קטלוג PDF, אתר ציבורי וניהול מחירים (מודולים חדשים מעל `Lot`), Bidspirit (ייצוא CSV/ZIP קיים; אין אינטגרציה רשמית — אין API מאומת), ריבוי בתי מכירות (`organizationId` בכל טבלה).
