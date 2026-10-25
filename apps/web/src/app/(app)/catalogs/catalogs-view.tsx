import Link from "next/link";
import { BookOpen } from "lucide-react";
import type { AuctionHouse } from "@prisma/client";
import type { UserPrincipal } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listCatalogs } from "@/server/services/catalogs";
import { CatalogStatusBadge } from "@/components/ui/badge";
import { EmptyState, PageBody, PageHeader, Progress } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { CatalogActions, CatalogsToolbar, NewCatalogButton } from "./catalogs-client";
import { HouseSwitcher } from "@/components/house-switcher";

export interface CatalogsSearch {
  q?: string;
  status?: string;
  sort?: string;
  new?: string;
}

/** Catalog list of one auction house (both houses share the inventory, never the catalogs). */
export async function CatalogsView({ user, house, houses, sp }: { user: UserPrincipal; house: AuctionHouse; houses: AuctionHouse[]; sp: CatalogsSearch }) {
  const status = sp.status ?? "OPEN";
  const all = await listCatalogs(user, { q: sp.q, status: status === "OPEN" ? undefined : status, sort: sp.sort, houseId: house.id });
  const catalogs = status === "OPEN" ? all.filter((c) => c.status !== "ARCHIVED") : all;
  const canEdit = can(user.role, "catalog.edit");

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "בתי מכירות", href: "/houses" }, { label: house.name }]}
        title={`קטלוגים · ${house.name}`}
        meta={<span>{catalogs.length} קטלוגים</span>}
        actions={
          <>
            {houses.length > 1 && <HouseSwitcher houses={houses.map((h) => ({ slug: h.slug, name: h.name, color: h.accentColor }))} active={house.slug} />}
            {canEdit && <NewCatalogButton autoOpen={sp.new === "1"} houseId={house.id} houseName={house.name} />}
          </>
        }
      />
      <PageBody>
        <CatalogsToolbar q={sp.q ?? ""} status={status} sort={sp.sort ?? "updated"} />
        <div className="card mt-4 overflow-x-auto">
          {catalogs.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={sp.q ? "לא נמצאו קטלוגים" : "עדיין אין קטלוגים"}>
              {sp.q ? "נסו מילת חיפוש אחרת או שנו את הסינון." : canEdit ? "צרו את הקטלוג הראשון כדי להתחיל להוסיף ספרים ולצלם." : "מנהל או עורך יכולים ליצור קטלוג."}
            </EmptyState>
          ) : (
            <table className="w-full min-w-[760px] text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-start text-[12.5px] text-muted">
                  <th className="w-24 px-5 py-3 text-start font-medium">מספר</th>
                  <th className="px-3 py-3 text-start font-medium">שם הקטלוג</th>
                  <th className="w-28 px-3 py-3 text-start font-medium">סטטוס</th>
                  <th className="w-56 px-3 py-3 text-start font-medium">התקדמות</th>
                  <th className="w-24 px-3 py-3 text-start font-medium">תמונות</th>
                  <th className="w-28 px-3 py-3 text-start font-medium">מכירה</th>
                  <th className="w-28 px-3 py-3 text-start font-medium">עודכן</th>
                  <th className="w-14 px-3 py-3" aria-label="פעולות" />
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {catalogs.map((c) => (
                  <tr key={c.id} className="relative transition-colors hover:bg-stone-2">
                    <td className="px-5 py-3.5">
                      <span className="num inline-flex h-7 min-w-9 items-center justify-center rounded-md bg-stone px-2 text-[13px] font-semibold">{c.number}</span>
                    </td>
                    <td className="px-3 py-3.5">
                      {/* stretched link: the whole row opens the catalog, the actions cell sits above it */}
                      <Link href={`/catalogs/${c.id}`} className="font-semibold text-ink after:absolute after:inset-0">
                        {c.name}
                      </Link>
                      {c.description && <div className="max-w-md truncate text-[12.5px] text-muted">{c.description}</div>}
                    </td>
                    <td className="px-3 py-3.5">
                      <CatalogStatusBadge status={c.status} />
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="flex items-center gap-3">
                        <Progress value={c.completedCount} max={c.lotCount} className="w-28" />
                        <span className="num text-[12.5px] text-muted">
                          {c.completedCount}/{c.lotCount}
                        </span>
                      </div>
                    </td>
                    <td className="num px-3 py-3.5 text-start text-ink-2">{fmt.num(c.photoCount)}</td>
                    <td className="px-3 py-3.5 text-muted">{c.saleDate ? fmt.date(c.saleDate) : "—"}</td>
                    <td className="px-3 py-3.5 text-muted" title={fmt.dateTime(c.updatedAt)}>
                      {fmt.relative(c.updatedAt)}
                    </td>
                    <td className="relative z-10 px-3 py-3.5">
                      {canEdit && (
                        <CatalogActions
                          catalog={{
                            id: c.id,
                            number: c.number,
                            name: c.name,
                            description: c.description,
                            saleDate: c.saleDate ? c.saleDate.toISOString().slice(0, 10) : null,
                            status: c.status,
                            photoCount: c.photoCount,
                          }}
                          canDelete={can(user.role, "catalog.delete")}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </PageBody>
    </>
  );
}
