# פריסה ל-Railway (ללא Docker)

הפריסה משתמשת במנגנון הבנייה המנוהל של Railway (Railpack) לפי `railway.json` שבשורש המאגר — אין Dockerfile.

## 1. אחסון תמונות — Cloudflare R2 (או AWS S3)
1. Cloudflare → R2 → Create bucket (למשל `avot-studio-originals`). **אל** תפעילו גישה ציבורית — כל הגישה דרך קישורים חתומים קצרי-מועד.
2. R2 → Manage API tokens → Object Read & Write לדלי הזה. רשמו Access Key ID, Secret, ו-Endpoint: `https://<account-id>.r2.cloudflarestorage.com`.
3. מומלץ: הפעלת Object Versioning / Lifecycle לפי מדיניות הגיבוי (ראו [security.md](security.md)).

אסור להשתמש באחסון מקומי בייצור — הדיסק של שרת Railway זמני. האפליקציה מסרבת לעלות עם `APP_ENV=production` ו-`STORAGE_DRIVER=local`.

## 2. פרויקט Railway
1. New Project → Deploy from GitHub repo → בחרו את המאגר. Root directory: שורש המאגר (ה-`railway.json` מגדיר build ו-start).
2. מסד הנתונים: **Neon** (הוגדר באוקטובר 2026 — הנתונים הועברו אליו). ב-Service של האתר: Variables → `DATABASE_URL` = מחרוזת ה-**Direct connection** של Neon (המארח **בלי** `-pooler`), עם `sslmode=require&channel_binding=require&schema=public`. אין צורך במסד PostgreSQL של Railway.
3. משתני סביבה (Variables):

| משתנה | ערך |
|---|---|
| `APP_ENV` | `production` |
| `APP_URL` | הכתובת הציבורית, למשל `https://studio.avot.co.il` |
| `DATABASE_URL` | Neon, Direct connection (ראו סעיף 2) |
| `APP_SECRET` | **אותו ערך כמו ב-`apps/web/.env.local`** — הוא מצפין את סודות עמדות הצילום השמורות במסד. ערך חדש רק במסד ריק: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | שם הדלי |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | מה-token |
| `ENABLE_SIMULATOR` | `false` |
| `JOB_WORKER_ENABLED` | `true` |
| `LOG_LEVEL` | `info` |
| `S3_FORCE_PATH_STYLE` | `false` (R2) |

**אסור להעלות:** `ADMIN_PASSWORD` (משמש רק להרצה חד-פעמית של create-admin), `STORAGE_LOCAL_DIR`, וקובץ `.env.local` עצמו (הוא ב-`.gitignore`).

4. Deploy. סדר הפעולות: `npm ci && npm run build` (כולל `prisma generate`), ואז בכל הפעלה `prisma migrate deploy && next start` — migrations רצות לפני שהשרת מקבל תעבורה. בדיקת בריאות: `/api/health`.
5. Settings → Networking → Generate Domain או Custom Domain (Railway מספק HTTPS).

## 2א. העברת התמונות הקיימות לדלי
מסד הנתונים מצביע על מפתחות אחסון שקיימים כרגע רק ב-`apps/web/.data/storage` במחשב הפיתוח. לפני השימוש בשרת:
```powershell
cd apps\web
$env:S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"; $env:S3_BUCKET="…"; $env:S3_ACCESS_KEY_ID="…"; $env:S3_SECRET_ACCESS_KEY="…"
npm run storage:upload -- --dry-run     # מה יועלה
npm run storage:upload                  # העלאה, אותם מפתחות, בדיקת גודל לכל קובץ
npm run storage:upload -- --verify      # כל PhotoFile במסד קיים בדלי בגודל הנכון
```

## 3. משתמש מנהל ראשון
Railway → Service → ⋯ → Shell (או `railway run` מקומית):
```bash
ADMIN_EMAIL=you@avot.co.il ADMIN_NAME="שם מלא" ADMIN_PASSWORD='סיסמה-חזקה' npx tsx apps/web/scripts/create-admin.ts
```
(הסקריפט יוצר את הארגון בהרצה הראשונה; הרצה חוזרת על אותו אימייל רק מאפסת סיסמה ומחזירה הרשאת מנהל.) — **לא נדרש** כשמשתמשים במסד Neon שהועבר: המשתמשים הקיימים כבר שם.

## 4. עמדות צילום
באתר: הגדרות ← עמדות צילום ← צימוד עמדה חדשה. ב-Capture Agent: צימוד לשרת עם `APP_URL` והקוד.

## הערות תפעול
- מופע אחד (`numReplicas: 1`) — מגביל הקצב הוא בזיכרון; עבודות הרקע בטוחות גם לכמה מופעים (`FOR UPDATE SKIP LOCKED`).
- לוגים: JSON בשורה (stdout) — ניתנים לחיפוש ב-Railway Logs.
- אם `npm ci` ב-Linux לא מתקין את הבינארי של `sharp` (באג ידוע של npm עם lockfile שנוצר ב-Windows): הוסיפו `npm install --os=linux --cpu=x64 sharp` לפקודת הבנייה.
- סביבות: Development (מקומי, `.env.local`), Staging (פרויקט/סביבת Railway נפרדת עם `APP_ENV=staging` ודלי נפרד), Production.
- הפריסה עצמה לא בוצעה מתוך סביבת הפיתוח — נדרשים חשבון Railway, חשבון Cloudflare ומאגר GitHub.
