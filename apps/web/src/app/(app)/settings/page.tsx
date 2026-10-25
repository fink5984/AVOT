import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { Panel } from "@/components/ui/misc";
import { CapturePrefsForm } from "./prefs-client";

export const metadata = { title: "העדפות צילום" };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const pref = await db.userPreference.findUnique({ where: { userId_key: { userId: user.userId, key: "capture" } } });

  return (
    <>
      <p className="mb-5 text-[13.5px] text-muted">ההעדפות נשמרות לחשבון שלך ומשוחזרות בכל מחשב.</p>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <CapturePrefsForm serverPrefs={pref?.value ?? null} />
        <div className="space-y-5">
          <Panel title="חיבור סמארטפון כמצלמת רשת" className="scroll-mt-20">
            <div id="phone" className="space-y-3 px-5 py-4 text-[13.5px] leading-relaxed text-ink-2">
              <p>מסך הצילום עובד עם כל מצלמה ש-Windows מזהה כמצלמת רשת. האפשרויות לטלפון:</p>
              <ol className="list-decimal space-y-2 ps-5">
                <li>
                  <strong>Windows 11 — Phone Link (״מצלמה מחוברת״), Android:</strong> הגדרות ← Bluetooth והתקנים ← התקנים ניידים ← ניהול התקנים ← הפעלת ״השתמש כמצלמה מחוברת״. דורש עדכון Windows 11 עדכני ואפליקציית ״קישור ל-Windows״ בטלפון. הטלפון יופיע ברשימת המצלמות.
                </li>
                <li>
                  <strong>תוכנות צד שלישי</strong> (למשל DroidCam, Iriun, Camo) — מתקינים בטלפון ובמחשב, והטלפון מופיע כמצלמה. אינן חלק מ-AVOT Studio ויש לבדוק את תנאי השימוש שלהן.
                </li>
              </ol>
              <p className="text-muted">
                חשוב: במצב מצלמת רשת התמונה נלקחת מזרם הווידאו של הטלפון (בדרך כלל 1080p–4K לפי התוכנה והטלפון), ולא מהמצלמה הסטילס המלאה של הטלפון. הרזולוציה בפועל מוצגת בראש מסך הצילום. למצלמת Canon EOS R7 נשמר הקובץ המקורי המלא.
              </p>
              <p className="text-muted">
                הדפדפן מבקש הרשאת מצלמה בפעם הראשונה. הגישה למצלמה אפשרית רק באתר מאובטח (HTTPS) או ב-localhost.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
