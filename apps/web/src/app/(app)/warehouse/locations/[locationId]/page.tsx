import Link from "next/link";
import { notFound } from "next/navigation";
import { Tag } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { getLocation, locationContents } from "@/server/services/warehouse";
import { locationLabel } from "@/server/services/location-label";
import { ButtonLink } from "@/components/ui/button";
import { CommercialStatusBadge, PhysicalStatusBadge } from "@/components/ui/badge";
import { EmptyState, PageBody, PageHeader, Panel } from "@/components/ui/misc";
import { t } from "@/i18n";
import { LocationEditor } from "./location-client";

export const metadata = { title: "מיקום במחסן" };

export default async function LocationPage({ params }: { params: Promise<{ locationId: string }> }) {
  const user = await requirePageUser("warehouse.view");
  const { locationId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) notFound();
  const loc = await getLocation(user.organizationId, locationId);
  if (!loc) notFound();
  const items = await locationContents(user.organizationId, loc.id);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "מחסן", href: "/warehouse" }, { label: loc.code }]}
        title={<span className="num font-mono">{loc.code}</span>}
        meta={
          <>
            <span>{locationLabel(loc)}</span>
            <span>
              <span className="num">{items.length}</span>
              {loc.capacity ? <>/<span className="num">{loc.capacity}</span></> : null} ספרים
            </span>
            {loc.sizeClass && <span>{t.bookSize[loc.sizeClass]}</span>}
            {loc.isFull && <span className="font-medium text-danger">סומן מלא</span>}
            {!loc.active && <span className="font-medium text-danger">מושבת</span>}
          </>
        }
        actions={
          can(user.role, "label.print") && (
            <ButtonLink href={`/labels/locations?ids=${loc.id}`} icon={<Tag />}>
              תווית מיקום
            </ButtonLink>
          )
        }
      />
      <PageBody className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="card overflow-hidden">
          {items.length === 0 ? (
            <EmptyState title="המיקום ריק">ספרים נכנסים למיקום בסריקה במסופון: ברקוד המדף ואז ברקודי הספרים.</EmptyState>
          ) : (
            <ul className="divide-y divide-rule text-[13.5px]">
              {items.map((i) => (
                <li key={i.id}>
                  <Link href={`/inventory/${i.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-stone-2">
                    <span className="num w-28 font-mono text-[12.5px] text-muted">{i.inventoryNumber}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                    <PhysicalStatusBadge status={i.physicalStatus} />
                    <CommercialStatusBadge status={i.commercialStatus} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {can(user.role, "warehouse.manage") && (
          <Panel title="הגדרות מיקום">
            <LocationEditor location={{ id: loc.id, sizeClass: loc.sizeClass, capacity: loc.capacity, isFull: loc.isFull, notes: loc.notes, active: loc.active }} />
          </Panel>
        )}
      </PageBody>
    </>
  );
}
