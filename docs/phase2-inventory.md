# Phase 2 — מלאי מרכזי, שני בתי מכירות, מחסן וברקודים

## מודל הנתונים

```
InventoryItem (ספר פיזי, ITM-000184)  ── PhotoAsset ── PhotoFile      תמונות המקור שייכות לספר
   │  photoStatus · physicalStatus · commercialStatus   (שלושה סטטוסים נפרדים, כל מעבר → InventoryStatusEvent)
   │  currentLocation ── StorageLocation ← Shelf ← WarehouseZone ← Warehouse
   │  movements (InventoryLocationMovement) · pickTasks (PickTask) · analyses (InventoryAnalysis — הכנה ל-AI)
   └─ lots: Lot  = "CatalogLot" — השתתפות הספר בקטלוג של בית מכירות
          │  assignmentStatus ACTIVE/ENDED · commercialStatus · description (+ LotDescriptionVersion)
          │  LotDisplayAsset — סדר/הסתרה לקטלוג זה · primaryAssetId — תמונה ראשית לקטלוג זה
          └─ Catalog ← AuctionHouse (אבות / טבין)
BarcodeScanEvent · StockCountSession/Location/Entry · UserHouseAccess
```

- הטבלה `Lot` שמרה על שמה ועל המזהים שלה, כדי שקישורים ותוויות QR ישנים ימשיכו לעבוד. משמעותה היא שיוך של ספר לקטלוג.
- **שיוך פעיל אחד לכל ספר**: האילוץ נאכף ב-`assignments.ts` וגם באינדקס חלקי במסד (`Lot_inventoryItemId_active_key`).
- מספר הפריט ייחודי בתוך הקטלוג. מספר הקטלוג ייחודי בתוך בית המכירות.
- מספר המלאי מוקצה אטומית מ-`Organization.inventorySerialSeq` ואינו משתנה לעולם.
- `PhotoAsset.lotId/catalogId` מציינים רק היכן צולמה התמונה במקור. הבעלים של התמונה הוא `inventoryItemId`.

## זרימות עיקריות

| פעולה | איפה | הערות |
|---|---|---|
| קליטת ספר | `/inventory` ← ״ספר חדש״ / ייבוא CSV | ספר שנוסף מתוך מסך קטלוג נקלט גם הוא למלאי |
| צילום | `/capture` (סריקת תווית) ← `/capture/<itemId>` | ה-Studio הקיים; אפשר לצלם לפני שיוך לקטלוג |
| תווית | `/labels/books?ids=…` · `/labels/locations` · `/labels/commands` | Code 128 (+QR), גליל תרמי או A4, PDF דרך הדפסה, ZPL |
| אחסון / העברה / איתור / ליקוט / ספירה | `/scanner` (מסופון) | ראו [warehouse-scanner.md](warehouse-scanner.md) |
| שיוך לקטלוג | עמוד הספר / פעולה מרובה במלאי | ללא שכפול הספר. שיוך פעיל קיים → 409 + אפשרות לסיים אותו ולשייך מחדש |
| סיום קטלוג | קטלוג ← ״עוד״ ← סיום הקטלוג | פריטים פעילים מסומנים ״לא נמכר״ והקטלוג עובר לארכיון |
| נמכר | תפריט פריט בקטלוג | השיוך מסתיים ונוצרת משימת ליקוט ← לוקט ← נארז ← נשלח |

## הרשאות

`ADMIN` רואה הכול. `EDITOR` מנהל בית מכירות. `PHOTOGRAPHER` עובד בצילום בלבד. `WAREHOUSE` עובד במחסן ובמסופון בלבד. `VIEWER` צופה בלבד.
אפשר להגביל משתמש לבית מכירות אחד (הגדרות ← משתמשים). ההגבלה חלה על קטלוגים ועל נתונים מסחריים, אבל לא על המלאי.
כל הבדיקות נעשות בצד השרת (`auth/permissions.ts`, `auth/houses.ts`).

## מיגרציה

- הסקריפט: `prisma/migrations/20261025100000_inventory_phase2`. הוא רץ כטרנזקציה אחת, ואינו מוחק או משנה אף מזהה או Storage Key.
- הרצת ניסיון ודו"ח התאמה: `scripts/migration-dry-run.ps1`. הסקריפט משחזר עותק של המסד, מריץ עליו את המיגרציה ומבצע 14 בדיקות התאמה.
- גיבוי: `scripts/db-backup.ps1`.
- חזרה לאחור: `prisma/rollback/20261025100000_inventory_phase2.down.sql`. התסריט נבדק: הוא מחזיר את הנתונים לזהים למקור. הוא מסרב לרוץ אם נוצרו בינתיים נתונים שאין להם מקום במבנה הישן.
- ב-Railway: קודם `db-backup.ps1 -DatabaseUrl <url>` ו-`migration-dry-run.ps1 -DatabaseUrl <url>`. אחר כך פריסה רגילה (`start:railway` מריץ `prisma migrate deploy`).

## בדיקות

- `npm test`: בדיקות יחידה (סיווג ברקודים, Code 128, ZPL, הרשאות, חוזים).
- `node tests/phase2-acceptance.mjs`: תסריט הקבלה של סעיף 18 ומקרי הקצה, ברמת ה-API. רץ מול שרת פעיל, 72 בדיקות.
- `e2e/phase2-ui.spec.ts`: ממשק מלא, כולל מצלמת רשת מדומה, מסופון בהקלדת Keyboard Wedge, עבודה לא מקוונת וסנכרון.
- **לא נבדק בחומרה:** מסופון Newland MT93 אמיתי, מדפסת תוויות תרמית, Canon EOS R7. ה-Capture Agent לא שונה, אבל לא נבנה ולא נבדק בסביבה הזו כי .NET אינו מותקן בה.
