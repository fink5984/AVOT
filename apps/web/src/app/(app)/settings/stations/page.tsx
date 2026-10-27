import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { isOnline } from "@/server/services/devices";
import { Panel } from "@/components/ui/misc";
import { StationsAdmin } from "./stations-client";

export const metadata = { title: "עמדות צילום" };

export default async function StationsPage() {
  const admin = await requirePageUser("device.manage");
  const [devices, users] = await Promise.all([
    db.device.findMany({ where: { organizationId: admin.organizationId, kind: "CAPTURE" }, orderBy: [{ revokedAt: "asc" }, { name: "asc" }], include: { assignedUser: { select: { name: true } } } }),
    db.user.findMany({ where: { organizationId: admin.organizationId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const controllers = await db.user.findMany({ where: { id: { in: devices.map((d) => d.controllingUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });

  return (
    <>
      <div className="space-y-5">
        <StationsAdmin
          serverUrl={env().APP_URL}
          users={users}
          devices={devices.map((d) => ({
            id: d.id,
            name: d.name,
            machineName: d.machineName,
            online: isOnline(d.lastSeenAt),
            lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
            agentVersion: d.agentVersion,
            cameraKind: d.cameraKind,
            cameraModel: d.cameraModel,
            cameraConnected: d.cameraConnected,
            storagePath: d.storagePath,
            freeDiskBytes: d.freeDiskBytes !== null ? Number(d.freeDiskBytes) : null,
            pendingUploads: d.pendingUploads,
            failedUploads: d.failedUploads,
            lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
            lastError: d.lastError,
            controllingUser: controllers.find((c) => c.id === d.controllingUserId)?.name ?? null,
            assignedUserId: d.assignedUserId,
            revoked: !!d.revokedAt,
          }))}
        />
        <Panel title="התקנת AVOT Capture Desktop במחשב הצילום" className="scroll-mt-20">
          <ol id="install" className="list-decimal space-y-2 px-5 py-4 ps-10 text-[13.5px] leading-relaxed text-ink-2">
            <li>לחצו ״הורדת תוכנת צילום״ והריצו את קובץ ההתקנה במחשב הצילום. אין צורך ב-PowerShell או בעריכת קבצים.</li>
            <li>אשף ההתקנה בודק: התקנת התוכנה, Canon EDSDK, זיהוי מצלמת EOS R7, תיקיית אחסון ושטח דיסק, צילום ניסיון והעלאה לשרת.</li>
            <li>
              Canon EDSDK: חבילה קניינית של Canon, ולכן היא לא מצורפת. הורידו אותה פעם אחת מפורטל המפתחים של Canon (גרסה 13.20.21 ל-Windows x64, אחרי התחברות עם החשבון שאושר), ובחרו את קובץ ה-ZIP באשף. ההתקנה מחלצת אותה בעצמה.
            </li>
            <li>צמדו את העמדה: לחצו כאן ״צימוד עמדה חדשה״ והזינו את הקוד בן 8 הספרות באשף (או בחלון התוכנה). הצימוד חד־פעמי — כיבוי המצלמה, ניתוק USB והפעלה מחדש של Windows לא דורשים צימוד חדש.</li>
            <li>מעבר למחשב אחר: התקינו שם, לחצו ״צימוד מחדש״ בשורת העמדה כאן וצמדו. המחשב הישן מאבד את ההרשאה מיד.</li>
            <li>סגרו את EOS Utility ותוכנות Canon אחרות — רק תוכנה אחת יכולה לשלוט במצלמה. הצילום עצמו נעשה באתר, והתוכנה מנהלת את המצלמה, השמירה המקומית וההעלאה ברקע.</li>
          </ol>
        </Panel>
      </div>
    </>
  );
}
