# Capture Agent — תוכנת עמדת הצילום

תוכנת Windows (x64, ‏.NET 10) שרצה ממגש המערכת במחשב שאליו מחוברת המצלמה. אחראית על: שליטה במצלמה (Canon EDSDK או סימולטור), שמירת המקור בדיסק **לפני** כל אישור, תור העלאה עמיד, ו-API מקומי ל-127.0.0.1 עבור מסך הצילום.

## התקנה בעמדה
1. הריצו `AvotCaptureAgent-Setup-<ver>.exe` (התקנה למשתמש הנוכחי — ללא הרשאות מנהל; כוללת את ‎.NET runtime).
2. העתיקו את Canon EDSDK לתיקייה `EDSDK` שבתיקיית ההתקנה ([canon-edsdk.md](canon-edsdk.md)).
3. בפעם הראשונה ייפתח חלון ״צימוד לשרת״. באתר: הגדרות ← עמדות צילום ← צימוד עמדה חדשה → העתיקו כתובת וקוד.
4. אופציה: ״הפעלה אוטומטית עם Windows״ (בתפריט המגש ובהתקנה).

## בנייה מהמקור
```powershell
cd apps\capture-agent
dotnet build                                  # Debug
dotnet test                                   # 24 בדיקות
dotnet run --project src\AvotCapture.Agent    # הרצה עם מגש מערכת
.\build-installer.ps1 [-Version 0.2.0]        # tests → publish self-contained → Inno Setup 6
```
`build-installer.ps1` דורש Inno Setup 6 (https://jrsoftware.org/isdl.php). בלעדיו נוצרת רק תיקיית `artifacts\publish`.

## שורת פקודה
```
AvotCaptureAgent.exe [--tray] [--headless] [--data <dir>] [--storage <dir>] [--port <n>] [--camera CANON|SIMULATOR]
AvotCaptureAgent.exe --pair <serverUrl> <code> [name]
```
`--headless` — ללא ממשק (לבדיקות/שירות). `--data` — תיקיית הגדרות/מסד/יומנים חלופית.

## היכן נשמר מה
| מה | מיקום |
|---|---|
| תמונות מקוריות | `%USERPROFILE%\Pictures\AVOT Studio\Catalog-<n>\Lot-<nnn>\<cover|title-page|interior|exterior>\` |
| קבצים שלא ניתן היה לשייך / קבצים חלקיים אחרי קריסה | `…\AVOT Studio\_unassigned\` (לא נמחקים לעולם אוטומטית) |
| קבצים בתהליך הורדה מהמצלמה | `…\AVOT Studio\.staging\` |
| הגדרות (אסימונים מוצפנים ב-DPAPI) | `%LOCALAPPDATA%\AvotCapture\settings.json` |
| מסד מקומי (תור, סטטוסים) | `%LOCALAPPDATA%\AvotCapture\captures.db` (SQLite WAL) |
| יומנים (30 יום) | `%LOCALAPPDATA%\AvotCapture\logs\agent-YYYYMMDD.log` |

## הגדרות (`settings.json`)
`StorageRoot`, `Port` (47800), `CameraMode` (`CANON`/`SIMULATOR`), `EdsdkPath`, `AutoStart`, `LocalRetentionDays` (0 = לשמור תמיד; אחרת מחיקת מקורות מקומיים *מאומתים בשרת* אחרי N ימים), `RawPlusJpegSimulation`.

הצילום נחסם כשהנפח הפנוי בכונן האחסון יורד מתחת ל-2GB; אזהרה מתחת ל-20GB (מוצגת במסך הצילום ובמסך העמדות).

## מצבי מצלמה ועיבוד
- `CameraMode`: `AUTO` (ברירת מחדל: Canon EDSDK אם מותקן, אחרת digiCamControl) | `DIGICAM` | `CANON` | `SIMULATOR` — בתפריט המגש או `--camera`. פרטים ב-[digicamcontrol.md](digicamcontrol.md). הגדרות: `DigiCamUrl`, `DigiCamExePath`, `DigiCamAutoLaunch`, `DigiCamTransfer`.
- הגדרות פרופיל הצילום (סיבוב, הסרת רקע, חיתוך …) באות מהדפדפן עם כל בקשת צילום (`processing`), נשמרות ב-`captures.db` עם הצילום ונשלחות לשרת ברישום — ה-Agent אינו מעבד תמונות. העיבוד בשרת: [green-screen-processing.md](green-screen-processing.md).

## עדכונים וגרסאות
- גרסת Agent וגרסת API נשלחות בכל heartbeat ומוצגות במסך העמדות. השרת מסרב לצימוד מגרסת API שונה.
- עדכון: הרצת קובץ התקנה חדש מעל הקיים (אותו AppId) — הנתונים, התור והתמונות נשמרים. ההתקנה סוגרת את התוכנה הרצה ומציעה להפעיל אותה בסיום; צילומים שבתור ממשיכים להעלות אחרי ההפעלה.
- הפצה עתידית אוטומטית: פרסום קובץ ההתקנה החתום בדלי/שרת + בדיקת גרסה ב-heartbeat (לא מומש בשלב זה). מומלץ לחתום את קובץ ההתקנה בתעודת Code Signing לפני הפצה.
