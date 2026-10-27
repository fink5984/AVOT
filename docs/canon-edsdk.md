# Canon EDSDK — השגה, רישוי והתקנה

## למה צריך את זה
השליטה במצלמת Canon EOS R7 (Live View, צילום מהמחשב, העברת קובץ מקורי, ISO/תריס/צמצם, סוללה) נעשית דרך **Canon EDSDK** הרשמי בלבד — ב-Capture Agent (C#), לא מהדפדפן. לא נעשה שימוש בספריות לא רשמיות.

## רישוי — מה מותר ומה לא
- ה-EDSDK ניתן לאחר הרשמה לתוכנית המפתחים של Canon ואישור תנאי הרישיון. **קובצי ה-DLL אינם נכללים במאגר** וקובץ ההתקנה של Capture Agent אינו מפיץ אותם (`build-installer.ps1` מסיר אותם במפורש; `.gitignore` חוסם אותם).
- לפני הפצה של ה-DLL יחד עם התוכנה לעמדות נוספות — בדקו בתנאי הרישיון של Canon שבחבילה שהורדתם אם ההפצה מותרת ובאילו תנאים. אם יש ספק: התקינו את ה-DLL ידנית בכל עמדה (שלב 3 למטה).

## שלבים
1. הרשמה: https://www.usa.canon.com/support/sdk (או https://developercommunity.usa.canon.com/) — בקשת גישה ל-EDSDK ל-Windows.
2. הורדת **EDSDK 13.x** (גרסה התומכת ב-EOS R7 — בדקו ברשימת המצלמות הנתמכות שבהערות הגרסה). להורדה מבחרו את חבילת Windows.
3. העתקת `EDSDK.dll` ו-`EdsImage.dll` מתוך `EDSDK_64\Dll` אל:
   - **עמדה מותקנת:** `%LOCALAPPDATA%\Programs\AVOT Capture Agent\EDSDK\`
   - **פיתוח:** `apps\capture-agent\third_party\EDSDK\` (מועתק אוטומטית ל-bin בבנייה)
   - או כל תיקייה אחרת + הגדרת `"EdsdkPath"` בקובץ `%LOCALAPPDATA%\AvotCapture\settings.json`.
4. הפעלה מחדש של Capture Agent. בתפריט המגש: מצב מצלמה → Canon EDSDK.
5. במצלמה: מצב צילום (לא ניגון), כבל USB-C ישיר למחשב (לא דרך מפצל), כיבוי חיבור Wi‑Fi/Bluetooth למחשב אם הוגדר, וסגירת EOS Utility.

## מה ממומש בקוד (`apps/capture-agent/src/AvotCapture.Canon`)
| יכולת | מימוש | אומת בחומרה |
|---|---|---|
| זיהוי מצלמה, שם דגם | `EdsGetCameraList`, `EdsGetDeviceInfo` | ❌ טרם |
| פתיחה/סגירת session, שחרור משאבים | `EdsOpenSession`/`EdsCloseSession`/`EdsRelease`/`EdsTerminateSDK` | ❌ |
| שמירה ישירה למחשב | `kEdsPropID_SaveTo = Host` + `EdsSetCapacity` | ❌ |
| צילום מהמחשב | `PressShutterButton` (Completely / Completely_NonAF) + OFF; ניסיון חוזר ב-DEVICE_BUSY | ❌ |
| קליטת קובץ מקורי | `DirItemRequestTransfer` → `EdsDownload` לקובץ staging → `EdsDownloadComplete` → בדיקת גודל | ❌ |
| RAW+JPEG כקבוצה אחת | ספירת קבצים לפי `ImageQuality` + שיוך FIFO לפי תפקיד | ❌ (נבדק בסימולטור) |
| כפתור הצילום הפיזי | קבצים ללא בקשה משויכים להקשר הפעיל (`/v1/context`) | ❌ |
| Live View | `Evf_OutputDevice |= PC`, `EdsDownloadEvfImage` ≤15fps | ❌ |
| ISO / תריס / צמצם / פיצוי | ערכים מותרים מ-`EdsGetPropertyDesc` בלבד (משתנה לפי חוגת המצבים) | ❌ |
| פוקוס אוטומטי | `DoEvfAf` ב-Live View, אחרת לחיצה חלקית | ❌ |
| סוללה | `kEdsPropID_BatteryLevel` (0xFFFFFFFF = מתאם חשמל → לא מוצג) | ❌ |
| ניתוק USB / כיבוי | `StateEvent_Shutdown` → ניסיון חיבור מחדש כל 3 שניות; `WillSoonShutDown` → הארכת טיימר | ❌ |
| מניעת שליטה כפולה | Mutex לכל תיקיית נתונים + Lease יחיד + הודעה על EOS Utility | ❌ |

כל הקוד הזה **נבנה, נטען ונבדק רק מול סימולטור**. אין להצהיר שהשליטה במצלמה נבדקה עד להשלמת [hardware-acceptance.md](hardware-acceptance.md). נקודות לבדיקה מיוחדת עם המצלמה: חתימות 64-bit (`EdsUInt64` בגדלים) מול הגרסה שתורד; קודי `ImageQuality` של R7; התנהגות `Completely_NonAF` מול AF; זמני הופעת `DirItemRequestTransfer` ב-RAW+JPEG.

## מגבלות פיזיות
- זום בעדשת הקיט (RF-S 18‑150) הוא ידני — אין שליטה תוכנתית.
- גובה המצלמה נקבע בעמוד הצילום הפיזי.


## EDSDK 13.20.21 — ייבוא מהאשף (מומלץ)

אחרי שהורדתם את ה-ZIP הרשמי של Windows מפורטל Canon (חשבון התוכנית שאושר): באשף ההתקנה, או בחלון AVOT Capture Desktop ← ״ייבוא Canon EDSDK…״ בוחרים את ה-ZIP. הייבוא בודק ש-`EDSDK.dll` הוא x64 ושקיים `EdsImage.dll`, מחלץ (עם הגנה מ-zip-slip) אל `%ProgramData%\AvotCapture\EDSDK`, וקובע `EdsdkPath`. החבילה אינה נשמרת במאגר ולא מופצת. הגרסה שבחרתם הייתה 13.20.21 — **יש לאמת בהערות הגרסה של Canon שהיא תומכת ב-EOS R7** (אם הגרסה המותקנת שונה, התוכנה מזהירה).

## Live View והגדלה מהמצלמה (לא דיגיטלית)

- **EVF Zoom של Canon** (`kEdsPropID_Evf_Zoom`): ״הגדלה במצלמה״ ‎5×‎/‎10×‎ + הזזת אזור ההגדלה (`Evf_ZoomPosition`), כמו הזכוכית המגדלת במסך המצלמה — פרטי תמונה אמיתיים מהחיישן, לבדיקת חדות. מוצגת רק כשהמצלמה מדווחת שהערך ניתן לקביעה במצב הנוכחי.
- זה שונה מהגדלת **CSS** בדפדפן (״הגדלת מסגרת״ במסך הצילום), שאינה מוסיפה פרטים אמיתיים.
- **מיקוד ידני בצעדים** (`CameraCommand_DriveLensEvf`, קרוב/רחוק × 3 גדלים): דורש עדשה במצב MF או AF+MF.
- איזון לבן, ISO, תריס, צמצם, פיצוי חשיפה: מרשימת הערכים שהמצלמה מדווחת. סוללה / מתח רשת, ואיכות (RAW / JPEG / RAW+JPEG) כקריאות.
- אין שליטה בזום אופטי: עדשת הפריים RF 35mm קבועה.

> **לא נבדק בחומרה.** קבועי ה-EDSDK החדשים (`Evf_Zoom` ‎0x507‎, `Evf_ZoomPosition` ‎0x508‎, `DriveLensEvf` ‎0x103‎ וערכי הצעדים) נלקחו מתיעוד ה-SDK ויש לוודא אותם מול `EDSDKTypes.h` של החבילה שהותקנה, ואז לעבור על [hardware-acceptance.md](hardware-acceptance.md) סעיף ה׳.
