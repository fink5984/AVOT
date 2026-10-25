import Link from "next/link";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { isOnline } from "@/server/services/devices";
import { PageBody, PageHeader, Panel, Progress } from "@/components/ui/misc";
import { fmt } from "@/i18n";

export const metadata = { title: "דוחות" };

const DAYS = 14;

export default async function ReportsPage() {
  const user = await requirePageUser("report.view");
  const org = user.organizationId;
  const since = new Date(Date.now() - DAYS * 86400_000);
  since.setHours(0, 0, 0, 0);

  const [catalogs, lotStats, photoStats, byUser, byDay, stuckFiles, devices] = await Promise.all([
    db.catalog.findMany({ where: { organizationId: org, status: { not: "ARCHIVED" } }, orderBy: { updatedAt: "desc" } }),
    db.lot.groupBy({ by: ["catalogId", "status"], where: { organizationId: org }, _count: { _all: true } }),
    db.photoAsset.groupBy({ by: ["catalogId"], where: { organizationId: org, deletedAt: null }, _count: { _all: true } }),
    db.photoAsset.groupBy({ by: ["createdById"], where: { organizationId: org, deletedAt: null, createdAt: { gte: since } }, _count: { _all: true } }),
    db.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, count(*) AS count
      FROM "PhotoAsset"
      WHERE "organizationId" = ${org}::uuid AND "deletedAt" IS NULL AND "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1 DESC`,
    db.photoFile.findMany({
      where: { uploadStatus: { not: "VERIFIED" }, createdAt: { lt: new Date(Date.now() - 30 * 60_000) }, asset: { organizationId: org, deletedAt: null } },
      include: { asset: { select: { id: true, sequence: true, category: true, item: { select: { id: true, inventoryNumber: true, title: true } } } } },
      take: 50,
      orderBy: { createdAt: "asc" },
    }),
    db.device.findMany({ where: { organizationId: org, revokedAt: null } }),
  ]);
  const users = await db.user.findMany({ where: { id: { in: byUser.map((u) => u.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const count = (catalogId: string, status?: string) => lotStats.filter((s) => s.catalogId === catalogId && (!status || s.status === status)).reduce((a, s) => a + s._count._all, 0);
  const deviceIssues = devices.filter((d) => d.failedUploads > 0 || d.lastError || (!isOnline(d.lastSeenAt) && d.pendingUploads > 0) || (d.freeDiskBytes !== null && Number(d.freeDiskBytes) < 10 * 1024 ** 3));

  return (
    <>
      <PageHeader title="דוחות" meta={<span>נתונים מתוך המערכת · עודכן {fmt.dateTime(new Date())}</span>} />
      <PageBody className="space-y-6">
        <Panel title="מצב קטלוגים">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-[12.5px] text-muted">
                  <th className="px-5 py-3 text-start font-medium">קטלוג</th>
                  <th className="w-48 px-3 py-3 text-start font-medium">התקדמות</th>
                  <th className="px-3 py-3 text-start font-medium">פריטים</th>
                  <th className="px-3 py-3 text-start font-medium">הושלמו</th>
                  <th className="px-3 py-3 text-start font-medium">ממתינים לבדיקה</th>
                  <th className="px-3 py-3 text-start font-medium">צילום חוזר</th>
                  <th className="px-3 py-3 text-start font-medium">טרם התחילו</th>
                  <th className="px-3 py-3 text-start font-medium">תמונות</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {catalogs.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-3">
                      <Link href={`/catalogs/${c.id}`} className="font-medium hover:underline">
                        <span className="num font-semibold">{c.number}</span> · {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Progress value={count(c.id, "COMPLETED")} max={count(c.id)} />
                    </td>
                    <td className="num px-3 py-2 text-start">{count(c.id)}</td>
                    <td className="num px-3 py-2 text-start">{count(c.id, "COMPLETED")}</td>
                    <td className="num px-3 py-2 text-start">
                      <Link href={`/catalogs/${c.id}?status=PENDING_REVIEW`} className="hover:underline">
                        {count(c.id, "PENDING_REVIEW")}
                      </Link>
                    </td>
                    <td className="num px-3 py-2 text-start">
                      <Link href={`/catalogs/${c.id}?status=NEEDS_RESHOOT`} className="hover:underline">
                        {count(c.id, "NEEDS_RESHOOT")}
                      </Link>
                    </td>
                    <td className="num px-3 py-2 text-start">{count(c.id, "NOT_STARTED")}</td>
                    <td className="num px-3 py-2 text-start">{fmt.num(photoStats.find((p) => p.catalogId === c.id)?._count._all ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title={`צילומים לפי משתמש · ${DAYS} ימים אחרונים`}>
            <table className="w-full text-[13px]">
              <tbody className="divide-y divide-rule">
                {byUser.length === 0 && (
                  <tr>
                    <td className="px-4 py-4 text-center text-muted">אין צילומים בתקופה זו</td>
                  </tr>
                )}
                {byUser
                  .sort((a, b) => b._count._all - a._count._all)
                  .map((u) => (
                    <tr key={u.createdById ?? "none"}>
                      <td className="px-5 py-2.5">{users.find((x) => x.id === u.createdById)?.name ?? "לא משויך (ייבוא/עמדה)"}</td>
                      <td className="num w-24 px-5 py-2.5 text-start font-semibold">{fmt.num(u._count._all)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Panel>
          <Panel title={`צילומים לפי תאריך · ${DAYS} ימים אחרונים`}>
            <table className="w-full text-[13px]">
              <tbody className="divide-y divide-rule">
                {byDay.length === 0 && (
                  <tr>
                    <td className="px-4 py-4 text-center text-muted">אין צילומים בתקופה זו</td>
                  </tr>
                )}
                {byDay.map((d) => {
                  const peak = Math.max(...byDay.map((x) => Number(x.count)));
                  return (
                    <tr key={d.day.toISOString()}>
                      <td className="w-32 px-5 py-2.5">{fmt.date(d.day)}</td>
                      <td className="px-3 py-2.5">
                        <div className="h-2 rounded-full bg-ink/80" style={{ width: `${Math.max(2, (Number(d.count) / peak) * 100)}%` }} aria-hidden />
                      </td>
                      <td className="num w-20 px-5 py-2.5 text-start font-semibold">{fmt.num(Number(d.count))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel title="תקלות סנכרון">
          {stuckFiles.length === 0 && deviceIssues.length === 0 ? (
            <p className="px-5 py-5 text-[13.5px] text-muted">אין קבצים תקועים ואין תקלות בעמדות צילום.</p>
          ) : (
            <div className="divide-y divide-rule text-[13px]">
              {deviceIssues.map((d) => (
                <div key={d.id} className="px-4 py-2">
                  <span className="font-medium">עמדה: {d.name}</span>
                  <span className="text-muted">
                    {" "}
                    · {isOnline(d.lastSeenAt) ? "מחוברת" : `לא מחוברת מאז ${fmt.dateTime(d.lastSeenAt)}`} · {d.pendingUploads} ממתינות · {d.failedUploads} נכשלו
                    {d.freeDiskBytes !== null && ` · דיסק פנוי ${fmt.bytes(d.freeDiskBytes)}`}
                  </span>
                  {d.lastError && <div className="text-[12px] text-danger">{d.lastError}</div>}
                </div>
              ))}
              {stuckFiles.map((f) => (
                <div key={f.id} className="px-4 py-2">
                  <Link href={`/inventory/${f.asset.item.id}`} className="font-medium hover:underline">
                    {f.asset.item.inventoryNumber} · {f.asset.item.title} · צילום {f.asset.sequence}
                  </Link>
                  <span className="text-muted">
                    {" "}
                    · {f.role === "RAW" ? "RAW" : "מקור"} · {f.uploadStatus === "FAILED" ? "ההעלאה נכשלה" : "רשום ללא קובץ מאומת"} · {f.uploadAttempts} ניסיונות · נרשם {fmt.relative(f.createdAt)}
                  </span>
                  {f.lastError && <div className="text-[12px] text-danger">{f.lastError}</div>}
                </div>
              ))}
              <p className="px-4 py-2 text-[12px] text-muted">
                קובץ ״רשום ללא קובץ מאומת״ פירושו שהעמדה או הדפדפן רשמו את הצילום אך ההעלאה טרם הושלמה. הקובץ המקורי שמור בעמדה ויעלה מחדש אוטומטית.
              </p>
            </div>
          )}
        </Panel>

      </PageBody>
    </>
  );
}
