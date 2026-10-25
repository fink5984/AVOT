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
    db.device.findMany({ where: { organizationId: admin.organizationId }, orderBy: [{ revokedAt: "asc" }, { name: "asc" }], include: { assignedUser: { select: { name: true } } } }),
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
        <Panel title="התקנת Capture Agent במחשב הצילום" className="scroll-mt-20">
          <ol id="install" className="list-decimal space-y-2 px-5 py-4 ps-10 text-[13.5px] leading-relaxed text-ink-2">
            <li>הורידו והתקינו את AVOT Capture Agent (קובץ ההתקנה נבנה מהמאגר — ראו docs/capture-agent.md). התוכנה רצה ממגש המערכת ויכולה לעלות אוטומטית עם Windows.</li>
            <li>
              למצלמת Canon: התקינו את Canon EDSDK לפי docs/canon-edsdk.md (הורדה מאתר המפתחים של Canon לאחר הרשמה; הקבצים אינם נכללים במאגר בשל תנאי הרישיון). בלי EDSDK התוכנה עובדת במצב סימולטור בלבד.
            </li>
            <li>סגרו את EOS Utility ותוכנות Canon אחרות — רק תוכנה אחת יכולה לשלוט במצלמה בכל רגע.</li>
            <li>חברו את המצלמה בכבל USB, הדליקו אותה והעבירו אותה למצב צילום.</li>
            <li>כאן במסך זה לחצו ״צימוד עמדה חדשה״, ובתוכנה (תפריט מגש המערכת ← צימוד) הזינו את כתובת השרת ואת הקוד בן 8 הספרות.</li>
            <li>במסך הצילום בחרו את המצלמה מרשימת המצלמות. הדפדפן עשוי לבקש הרשאה לגישה לרשת המקומית — אשרו אותה.</li>
          </ol>
        </Panel>
      </div>
    </>
  );
}
