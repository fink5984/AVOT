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
import { WarehouseStructure } from "./warehouse-structure";
import { StartCountButton } from "./start-count";

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
            <span className="num">{locations.length}</span> מדפים ומיקומים · <span className="num">{tree.length}</span> מחסנים
          </span>
        }
        actions={
          <>
            <ButtonLink href="/labels/commands" icon={<Tag />}>
              ברקודי פקודה
            </ButtonLink>
            {can(user.role, "warehouse.operate") && <StartCountButton zones={tree.flatMap((w) => w.zones.map((z) => ({ id: z.id, name: `${w.name} · ${z.name}` })))} />}
            {can(user.role, "warehouse.operate") && (
              <ButtonLink href="/scans" icon={<ClipboardList />}>
                יומן סריקות
              </ButtonLink>
            )}
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
          <WarehouseStructure
            perms={{ manage, print: can(user.role, "label.print"), relocate: can(user.role, "inventory.relocate") }}
            warehouses={tree.map((w) => ({
              id: w.id,
              code: w.code,
              name: w.name,
              isDefault: w.isDefault,
              zones: w.zones.map((z) => ({
                id: z.id,
                code: z.code,
                name: z.name,
                shelves: z.shelves.map((sh) => ({ id: sh.id, code: sh.code, active: sh.locations.some((l) => l.active), books: sh.locations.reduce((n, l) => n + l.itemCount, 0), locationIds: sh.locations.map((l) => l.id) })),
              })),
            }))}
          />

          <aside className="space-y-4">
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
