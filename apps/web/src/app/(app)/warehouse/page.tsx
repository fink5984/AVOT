import Link from "next/link";
import { ClipboardList, PackageOpen, ScanLine, Tag } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { warehouseTree } from "@/server/services/warehouse";
import { listCounts } from "@/server/services/counting";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, PageBody, PageHeader, Panel, Stat } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { WarehouseEditor, ShelfLabelButton } from "./warehouse-client";

export const metadata = { title: "מחסן" };

const COUNT_STATUS: Record<string, string> = { OPEN: "בספירה", REVIEW: "ממתינה לאישור", APPROVED: "אושרה", CANCELLED: "בוטלה" };

export default async function WarehousePage() {
  const user = await requirePageUser("warehouse.view");
  const org = user.organizationId;
  const [tree, counts, byStatus, openPicks] = await Promise.all([
    warehouseTree(org),
    listCounts(org),
    db.inventoryItem.groupBy({ by: ["physicalStatus"], where: { organizationId: org }, _count: { _all: true } }),
    db.pickTask.count({ where: { organizationId: org, status: { in: ["OPEN", "PICKED", "PACKED"] } } }),
  ]);
  const n = (s: string) => byStatus.find((b) => b.physicalStatus === s)?._count._all ?? 0;
  const manage = can(user.role, "warehouse.manage");
  const locations = tree.flatMap((w) => w.zones.flatMap((z) => z.shelves.flatMap((s) => s.locations)));

  return (
    <>
      <PageHeader
        title="מחסן"
        meta={
          <span>
            <span className="num">{locations.length}</span> מיקומי אחסון · <span className="num">{tree.length}</span> מחסנים
          </span>
        }
        actions={
          <>
            <ButtonLink href="/labels/commands" icon={<Tag />}>
              ברקודי פקודה
            </ButtonLink>
            <ButtonLink href="/warehouse/picking" icon={<PackageOpen />}>
              ליקוט ומשלוח
            </ButtonLink>
            {can(user.role, "warehouse.operate") && (
              <ButtonLink href="/scanner" variant="primary" icon={<ScanLine />}>
                פתיחת מסופון
              </ButtonLink>
            )}
          </>
        }
      />
      <PageBody className="space-y-6">
        <div className="card grid grid-cols-2 gap-px overflow-hidden bg-rule p-0 sm:grid-cols-3 lg:grid-cols-6 [&>*]:bg-paper">
          <Stat label={t.physicalStatus.IN_STORAGE} value={fmt.num(n("IN_STORAGE"))} tone="green" href="/inventory" />
          <Stat label={t.physicalStatus.AWAITING_STORAGE} value={fmt.num(n("AWAITING_STORAGE"))} tone="warn" href="/inventory?view=no_location" />
          <Stat label={t.physicalStatus.AWAITING_PICK} value={fmt.num(n("AWAITING_PICK"))} tone="accent" href="/warehouse/picking" />
          <Stat label="לוקטו / נארזו" value={fmt.num(n("PICKED") + n("PACKED"))} tone="info" href="/warehouse/picking" />
          <Stat label={t.physicalStatus.SHIPPED} value={fmt.num(n("SHIPPED"))} />
          <Stat label={t.physicalStatus.MISSING} value={fmt.num(n("MISSING"))} tone={n("MISSING") ? "danger" : undefined} href="/inventory?view=missing" />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="space-y-4">
            {tree.map((w) => (
              <div key={w.id} className="card overflow-hidden">
                <div className="flex items-center gap-3 border-b border-rule px-5 py-3">
                  <h2 className="text-[15px] font-semibold">{w.name}</h2>
                  <span className="num font-mono text-[12px] text-muted">{w.code}</span>
                  {w.isDefault && <span className="text-[12px] text-muted">ראשי</span>}
                </div>
                {w.zones.length === 0 ? (
                  <EmptyState title="עדיין לא הוגדרו אזורים">{manage ? "הוסיפו אזור, מדפים ותאים בטופס שבצד." : "מנהל מערכת מגדיר את מבנה המחסן."}</EmptyState>
                ) : (
                  <div className="divide-y divide-rule">
                    {w.zones.map((z) => (
                      <div key={z.id} className="px-5 py-3">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="font-semibold">{z.name}</span>
                          <span className="num font-mono text-[12px] text-muted">{z.code}</span>
                          <span className="text-[12px] text-muted">
                            · <span className="num">{z.shelves.length}</span> מדפים
                          </span>
                        </div>
                        <div className="space-y-2">
                          {z.shelves.map((s) => (
                            <div key={s.id} className="flex flex-wrap items-start gap-2">
                              <div className="w-28 shrink-0 pt-1 text-[13px]">
                                מדף <span className="num font-semibold">{s.code}</span>
                                {s.shelfType && <div className="text-[11.5px] text-muted">{s.shelfType}</div>}
                              </div>
                              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                                {s.locations.map((l) => {
                                  const full = l.isFull || (l.capacity !== null && l.itemCount >= l.capacity);
                                  return (
                                    <Link
                                      key={l.id}
                                      href={`/warehouse/locations/${l.id}`}
                                      className={cn(
                                        "rounded-md px-2 py-1 text-[12px] ring-1 transition-colors",
                                        !l.active ? "bg-stone text-faint ring-rule line-through" : full ? "bg-danger-soft text-danger ring-danger/20" : l.itemCount ? "bg-green-soft text-green-2 ring-green/20" : "bg-paper text-ink-2 ring-rule hover:bg-stone-2",
                                      )}
                                      title={`${l.code} · ${l.itemCount}${l.capacity ? `/${l.capacity}` : ""} ספרים${l.sizeClass ? ` · ${t.bookSize[l.sizeClass]}` : ""}`}
                                    >
                                      <span className="num font-mono">{l.cell}</span>
                                      <span className="num ms-1 opacity-70">
                                        {l.itemCount}
                                        {l.capacity ? `/${l.capacity}` : ""}
                                      </span>
                                    </Link>
                                  );
                                })}
                                {s.locations.length > 0 && <ShelfLabelButton ids={s.locations.map((l) => l.id)} />}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>

          <aside className="space-y-4">
            {manage && <WarehouseEditor warehouses={tree.map((w) => ({ id: w.id, name: w.name, zones: w.zones.map((z) => ({ id: z.id, code: z.code, name: z.name, shelves: z.shelves.map((s) => ({ id: s.id, code: s.code })) })) }))} />}
            <Panel title="ספירות מלאי">
              {counts.length === 0 ? (
                <p className="px-5 py-4 text-[13px] text-muted">ספירה מתחילים מהמסופון (מצב ספירת מלאי).</p>
              ) : (
                <ul className="divide-y divide-rule text-[13px]">
                  {counts.slice(0, 12).map((c) => (
                    <li key={c.id}>
                      <Link href={`/warehouse/counts/${c.id}`} className="flex items-center gap-2 px-5 py-2.5 hover:bg-stone-2">
                        <ClipboardList className="size-4 text-muted" />
                        <span>{c.zone?.name ?? "כל המחסן"}</span>
                        <span className="text-[12px] text-muted">{fmt.dateTime(c.startedAt)}</span>
                        <span className={cn("ms-auto text-[12px] font-medium", c.status === "REVIEW" ? "text-accent" : "text-muted")}>{COUNT_STATUS[c.status]}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <p className="px-1 text-[12.5px] text-muted">
              <span className="num">{openPicks}</span> משימות ליקוט / אריזה / משלוח פתוחות.
            </p>
          </aside>
        </div>
      </PageBody>
    </>
  );
}
