import type { AuctionHouse } from "@prisma/client";
import type { UserPrincipal } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listCatalogs } from "@/server/services/catalogs";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { CatalogsToolbar, NewCatalogButton } from "./catalogs-client";
import { CatalogsTable } from "./catalogs-table";
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
        <CatalogsTable
          canEdit={canEdit}
          canDelete={can(user.role, "catalog.delete")}
          emptyText={sp.q ? "נסו מילת חיפוש אחרת או שנו את הסינון." : canEdit ? "צרו את הקטלוג הראשון כדי להתחיל להוסיף ספרים ולצלם." : "מנהל או עורך יכולים ליצור קטלוג."}
          rows={catalogs.map((c) => ({
            id: c.id,
            number: c.number,
            name: c.name,
            description: c.description,
            saleDate: c.saleDate ? c.saleDate.toISOString().slice(0, 10) : null,
            status: c.status,
            lotCount: c.lotCount,
            completedCount: c.completedCount,
            photoCount: c.photoCount,
            updatedAt: c.updatedAt.toISOString(),
          }))}
        />
      </PageBody>
    </>
  );
}
