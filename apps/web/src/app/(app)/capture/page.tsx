import Link from "next/link";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { PhotoStatusBadge } from "@/components/ui/badge";
import { PageBody, PageHeader, Panel } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { CaptureOpener } from "./capture-client";

export const metadata = { title: "צילום" };

/**
 * Entry to photography: scan a book's tag (or type its inventory number) and
 * the capture studio opens on that book. Photos belong to the book, so it can
 * be photographed before it is assigned to any catalog.
 */
export default async function CaptureHome() {
  const user = await requirePageUser("photo.capture");
  const org = user.organizationId;
  const [queue, recent] = await Promise.all([
    db.inventoryItem.findMany({
      where: { organizationId: org, photoStatus: { in: ["NOT_STARTED", "NEEDS_RESHOOT", "IN_PROGRESS"] }, physicalStatus: { notIn: ["SHIPPED"] } },
      orderBy: [{ photoStatus: "desc" }, { serial: "asc" }],
      take: 30,
      select: { id: true, inventoryNumber: true, title: true, photoStatus: true, photoCount: true, currentLocation: { select: { code: true } } },
    }),
    db.captureSession.findMany({
      where: { userId: user.userId, inventoryItemId: { not: null } },
      orderBy: { lastActivityAt: "desc" },
      distinct: ["inventoryItemId"],
      take: 8,
      select: { inventoryItemId: true, lotId: true, lastActivityAt: true, shotCount: true },
    }),
  ]);
  const recentItems = await db.inventoryItem.findMany({ where: { id: { in: recent.map((r) => r.inventoryItemId!) } }, select: { id: true, inventoryNumber: true, title: true } });
  return (
    <>
      <PageHeader title="צילום" meta={<span>סרקו את תווית הספר כדי לפתוח אותו בעמדת הצילום</span>} />
      <PageBody className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <CaptureOpener />
          <Panel title={`ממתינים לצילום (${queue.length}${queue.length === 30 ? "+" : ""})`}>
            <ul className="divide-y divide-rule text-[13.5px]">
              {queue.map((i) => (
                <li key={i.id}>
                  <Link href={`/capture/${i.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-stone-2">
                    <span className="num w-28 font-mono text-[12.5px] text-muted">{i.inventoryNumber}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                    {i.currentLocation && <span className="num font-mono text-[12px] text-muted">{i.currentLocation.code}</span>}
                    <span className="num text-[12px] text-muted">{i.photoCount} תמונות</span>
                    <PhotoStatusBadge status={i.photoStatus} />
                  </Link>
                </li>
              ))}
              {queue.length === 0 && <li className="px-5 py-6 text-center text-muted">אין ספרים שממתינים לצילום.</li>}
            </ul>
          </Panel>
        </div>
        <Panel title="צולמו לאחרונה על ידיך">
          <ul className="divide-y divide-rule text-[13px]">
            {recent.map((r) => {
              const i = recentItems.find((x) => x.id === r.inventoryItemId);
              if (!i) return null;
              return (
                <li key={i.id}>
                  <Link href={`/capture/${r.lotId ?? i.id}`} className="block px-5 py-2.5 hover:bg-stone-2">
                    <span className="num font-mono text-[12px] text-muted">{i.inventoryNumber}</span> <span className="font-medium">{i.title}</span>
                    <div className="text-[11.5px] text-faint">{fmt.relative(r.lastActivityAt)}</div>
                  </Link>
                </li>
              );
            })}
            {recent.length === 0 && <li className="px-5 py-4 text-muted">עדיין לא צילמת.</li>}
          </ul>
        </Panel>
      </PageBody>
    </>
  );
}
