import Link from "next/link";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { actionLabel, describeData } from "@/server/services/activity";
import { Panel } from "@/components/ui/misc";
import { fmt } from "@/i18n";

export const metadata = { title: "יומן פעילות" };

const PAGE = 100;

/**
 * The one place for the activity log. Other screens deliberately don't show
 * activity feeds; a book's history is reachable from its menu (?lot=).
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string; user?: string; type?: string; lot?: string }> }) {
  const admin = await requirePageUser("audit.view");
  const sp = await searchParams;
  const before = sp.before ? new Date(sp.before) : undefined;
  const rows = await db.auditLog.findMany({
    where: {
      organizationId: admin.organizationId,
      ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
      ...(sp.user ? { userId: sp.user } : {}),
      ...(sp.type ? { entityType: sp.type } : {}),
      ...(sp.lot && /^[0-9a-f-]{36}$/i.test(sp.lot) ? { lotId: sp.lot } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: PAGE,
    include: { user: { select: { name: true } } },
  });
  const [users, lot] = await Promise.all([
    db.user.findMany({ where: { organizationId: admin.organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    sp.lot && /^[0-9a-f-]{36}$/i.test(sp.lot)
      ? db.lot.findFirst({ where: { id: sp.lot, organizationId: admin.organizationId }, select: { id: true, lotNumber: true, title: true, catalog: { select: { number: true } } } })
      : null,
  ]);
  const last = rows[rows.length - 1];
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ user: sp.user, type: sp.type, lot: sp.lot, ...extra })) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <>
      <div className="space-y-4">
        <p className="text-[13.5px] text-muted">מי צילם, ערך, העביר, מחק ושחזר — כל פעולה חשובה במערכת, במקום אחד.</p>
        {lot && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-stone px-4 py-2.5 text-[13.5px]">
            <span>
              מוצגת היסטוריה של פריט{" "}
              <Link href={`/lots/${lot.id}`} className="font-medium hover:underline">
                <span className="num">{lot.catalog.number}/{lot.lotNumber}</span> · {lot.title}
              </Link>
            </span>
            <Link href={qs({ lot: undefined })} className="ms-auto text-[13px] font-medium text-muted hover:text-ink">
              הצגת כל הפעילות
            </Link>
          </div>
        )}
        <form className="flex flex-wrap gap-2 text-[13.5px]" action="/settings/audit">
          {sp.lot && <input type="hidden" name="lot" value={sp.lot} />}
          <select name="user" defaultValue={sp.user ?? ""} className="h-9 rounded-md border border-rule-strong bg-paper px-3 shadow-card" aria-label="סינון לפי משתמש">
            <option value="">כל המשתמשים</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select name="type" defaultValue={sp.type ?? ""} className="h-9 rounded-md border border-rule-strong bg-paper px-3 shadow-card" aria-label="סינון לפי סוג">
            <option value="">כל הסוגים</option>
            <option value="asset">תמונות</option>
            <option value="lot">פריטים</option>
            <option value="catalog">קטלוגים</option>
            <option value="user">משתמשים</option>
            <option value="device">עמדות</option>
            <option value="export">ייצוא</option>
            <option value="session">התחברויות</option>
          </select>
          <button className="h-9 rounded-md bg-ink px-4 font-medium text-paper hover:bg-[#2d2b28]">סינון</button>
        </form>
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-[12.5px] text-muted">
                  <th className="w-40 px-5 py-3 text-start font-medium">זמן</th>
                  <th className="w-40 px-3 py-3 text-start font-medium">משתמש</th>
                  <th className="px-3 py-3 text-start font-medium">פעולה</th>
                  <th className="w-32 px-3 py-3 text-start font-medium">קישור</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((r) => {
                  const detail = describeData(r.action, r.data);
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">{fmt.dateTime(r.createdAt)}</td>
                      <td className="px-3 py-2.5 font-medium">{r.user?.name ?? (r.deviceId ? "עמדת צילום" : "מערכת")}</td>
                      <td className="px-3 py-2.5">
                        {actionLabel(r.action)}
                        {detail && <span className="text-muted"> · {detail}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.lotId && !sp.lot && (
                          <Link href={`/lots/${r.lotId}`} className="font-medium text-muted hover:text-ink">
                            לפריט
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        {rows.length === PAGE && last && (
          <Link href={qs({ before: last.createdAt.toISOString() })} className="inline-flex h-9 items-center rounded-md border border-rule-strong bg-paper px-4 text-[13.5px] font-medium shadow-card hover:bg-stone-2">
            רשומות ישנות יותר
          </Link>
        )}
      </div>
    </>
  );
}
