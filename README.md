# AVOT Studio

מערכת לניהול מחזור החיים של ספרים עתיקים — קליטה למלאי, צילום, ברקודים, מחסן, קטלוגים ומכירה — לשני בתי מכירות (**אבות** ו**טבין**) עם מלאי מרכזי משותף.

> **Phase 2:** מלאי מרכזי (ITM-…), בתי מכירות, מחסן ומסופון, ברקודים ותוויות, ליקוט וספירת מלאי. ראו [docs/phase2-inventory.md](docs/phase2-inventory.md) ו-[docs/warehouse-scanner.md](docs/warehouse-scanner.md).

צילום רציף לפי קטלוג → ספר → קטגוריה (כריכה, שער, פנים, חוץ), שמירה מקומית אמינה לפני כל אישור, סנכרון מאומת (SHA‑256) לענן, גלריות מקצועיות, ייצוא ZIP מסודר, הרשאות ויומן פעילות. ממשק עברי מלא (RTL).

```
apps/
  web/             Next.js 15 + TypeScript + Prisma/PostgreSQL — האתר, ה-API ומסך הצילום
  capture-agent/   C# / .NET 10 — תוכנת Windows לשליטה במצלמת Canon (EDSDK), שמירה מקומית וסנכרון
packages/
  shared/          מפתחות דומיין וחוזי API משותפים (Zod)
scripts/           start-dev.ps1, check-env.ps1, dev-db.ps1
docs/              ארכיטקטורה, חוזי API, התקנה, מדריכים, בדיקות חומרה
tests/             בדיקות smoke וביצועים מול שרת רץ
```

## מצבי מצלמה — מסך צילום אחד לכולם

| מצב | מתי | איך | שמירה אמינה |
|---|---|---|---|
| **מצלמת רשת / סמארטפון** | עכשיו, לפני הגעת ה-R7 | בדפדפן (MediaDevices / ImageCapture) | IndexedDB בדפדפן ← העלאה ← אימות SHA‑256 בשרת |
| **Canon EOS R7** | כשהמצלמה תגיע | Capture Agent + Canon EDSDK, דרך 127.0.0.1 | דיסק העמדה (fsync + שינוי שם אטומי + SQLite) ← העלאה ← אימות |
| **סימולטור** | פיתוח ובדיקות | בדפדפן או ב-Agent; קבצים מסומנים SIMULATOR | אותו מסלול בדיוק |

## הפעלה ראשונה (Windows 11, ללא Docker וללא WSL)

דרישות: Node.js 22 LTS, ‏PostgreSQL 15+ מותקן ב-Windows (או מסד בענן), ‏.NET 10 SDK (רק ל-Capture Agent).

```powershell
# בדיקת מוכנות הסביבה
.\scripts\check-env.ps1

# התקנה ראשונה: קובץ .env.local, npm install, מסד נתונים מקומי, migrations, משתמש מנהל
.\scripts\start-dev.ps1 -Setup

# הפעלה רגילה של האתר  →  http://localhost:3000
.\scripts\start-dev.ps1

# האתר + Capture Agent בחלון נפרד
.\scripts\start-dev.ps1 -Agent
```

`dev-db.ps1` יוצר אשכול PostgreSQL פרטי בתוך תיקיית הפרויקט (`.devdb`, פורט 5433) באמצעות קובצי PostgreSQL המותקנים — בלי לגעת בשירות PostgreSQL של המערכת. לשימוש בשרת קיים: הגדירו `DATABASE_URL` ב-`apps\web\.env.local` והריצו `start-dev.ps1 -SkipDb`.

### פקודות ידניות

```powershell
npm install                      # בשורש המאגר (npm workspaces)
cd apps\web
npm run db:migrate               # prisma migrate dev  (בייצור: npm run db:deploy)
npm run create-admin             # משתמש מנהל ראשון
npm run dev                      # פיתוח
npm run build; npm run start     # Production מקומי

cd ..\capture-agent
dotnet restore; dotnet build
dotnet run --project src\AvotCapture.Agent      # תוכנת העמדה (מגש המערכת)
.\build-installer.ps1                           # קובץ התקנה: artifacts\AvotCaptureAgent-Setup-<ver>.exe
```

## בדיקות

```powershell
cd apps\web
npm run typecheck                 # TypeScript strict
npm test                          # Vitest — לוגיקת שרת
npx playwright install chromium   # פעם אחת
npm run test:e2e                  # Playwright — כולל מבחן הקבלה המלא במצלמת רשת מדומה
node ..\..\tests\api-smoke.mjs    # smoke מול שרת רץ
npm run seed:perf; node ..\..\tests\perf-check.mjs; npm run seed:perf -- --purge   # ביצועים

cd ..\capture-agent
dotnet test                       # xUnit — תיאום צילום, שמירה, סנכרון, אסימונים
```

מבחן `agent-integration` מריץ את Capture Agent האמיתי (מצב סימולטור), מצמד אותו לשרת ומצלם דרכו מהדפדפן. בדיקת חומרה עם טלפון ועם EOS R7 פיזית: [docs/hardware-acceptance.md](docs/hardware-acceptance.md).

## תיעוד

- [Phase 2 — מלאי, בתי מכירות, מחסן, מיגרציה](docs/phase2-inventory.md)
- [מסופון מחסן](docs/warehouse-scanner.md)
- [digiCamControl כספק מצלמה (ללא EDSDK שלנו)](docs/digicamcontrol.md)
- [עיבוד תמונת ספר: סיבוב, הסרת רקע ירוק, חיתוך](docs/green-screen-processing.md)
- [ארכיטקטורה ומודל אמינות](docs/architecture.md)
- [חוזי API — שרת ו-Capture Agent](docs/api-contracts.md)
- [פריסה ל-Railway + Cloudflare R2](docs/deployment-railway.md)
- [Capture Agent — התקנה, הגדרות, שורת פקודה](docs/capture-agent.md)
- [Canon EDSDK — השגה, רישוי, התקנה](docs/canon-edsdk.md)
- [מדריך עבודה לצלם](docs/photographer-guide.md)
- [טיפול בתקלות מצלמה וסנכרון](docs/troubleshooting.md)
- [אבטחה, גיבויים ושחזור](docs/security.md)
- [בדיקות קבלה עם חומרה](docs/hardware-acceptance.md)

## מצב נוכחי

- נבדק אוטומטית: האתר (Production build), צילום מצלמת רשת דרך זרם וידאו אמיתי של Chromium, סימולטור, Capture Agent אמיתי במצב סימולטור, עבודה ללא אינטרנט, הרשאות, ייצוא ZIP, ביצועים עם ‎35,000 תמונות.
- **טרם נבדק בחומרה:** שליטה ב-Canon EOS R7 דרך EDSDK (קוד ה-EDSDK נבנה ונטען, אך לא הופעל מול מצלמה), וצילום מטלפון אמיתי כמצלמת רשת. ראו [hardware-acceptance.md](docs/hardware-acceptance.md).
