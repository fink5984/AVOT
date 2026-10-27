import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { listLots } from "@/server/services/lots";
import { canSeeHouse, catalogScope } from "@/server/auth/houses";
import { HouseMark } from "@/components/house-mark";
import { CatalogStatusBadge } from "@/components/ui/badge";
import { PageHeader, Progress } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { LotsTable, type LotRow } from "./lots-table";
import { CatalogHeaderActions } from "./catalog-header-actions";

export async function generateMetadata({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  const c = await db.catalog.findUnique({ where: { id: catalogId }, select: { number: true, name: true } }).catch(() => null);
  return { title: c ? `קטלוג ${c.number} · ${c.name}` : "קטלוג" };
}

export default async function CatalogPage({ params, searchParams }: { params: Promise<{ catalogId: string }>; searchParams: Promise<{ status?: string }> }) {
  const user = await requirePageUser("catalog.view");
  const { catalogId } = await params;
  const { status } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(catalogId)) notFound();
  const catalog = await db.catalog.findFirst({ where: { id: catalogId, organizationId: user.organizationId }, include: { auctionHouse: true } });
  if (!catalog || !canSeeHouse(user, catalog.auctionHouseId)) notFound();

  const [lots, otherCatalogs] = await Promise.all([
    listLots(user, catalogId),
    db.catalog.findMany({
      where: { organizationId: user.organizationId, id: { not: catalogId }, status: { not: "ARCHIVED" }, ...catalogScope(user) },
      select: { id: true, number: true, name: true, auctionHouse: { select: { name: true } } },
      orderBy: [{ auctionHouse: { sortOrder: "asc" } }, { updatedAt: "desc" }],
    }),
  ]);

  const rows: LotRow[] = lots.map((l) => ({
    id: l.id,
    lotNumber: l.lotNumber,
    sortOrder: l.sortOrder,
    title: l.title,
    subtitle: l.subtitle,
    author: l.author,
    status: l.status,
    photoCount: l.photoCount,
    counts: l.counts,
    thumbAssetId: l.thumbAssetId,
    updatedAt: l.updatedAt.toISOString(),
    inventoryItemId: l.inventoryItemId,
    inventoryNumber: l.inventoryNumber,
    assignmentStatus: l.assignmentStatus,
    commercialStatus: l.commercialStatus,
    locationCode: l.locationCode,
  }));
  const activeLots = lots.filter((l) => l.assignmentStatus === "ACTIVE").length;
  const sold = lots.filter((l) => l.commercialStatus === "SOLD").length;
  const done = lots.filter((l) => l.status === "COMPLETED").length;
  const photos = lots.reduce((a, l) => a + l.photoCount, 0);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "בתי מכירות", href: "/houses" }, { label: catalog.auctionHouse.name, href: `/houses/${catalog.auctionHouse.slug}` }, { label: `קטלוג ${catalog.number}` }]}
        eyebrow={<HouseMark name={catalog.auctionHouse.name} color={catalog.auctionHouse.accentColor} />}
        title={catalog.name}
        meta={
          <>
            <CatalogStatusBadge status={catalog.status} />
            <span>
              <span className="num">{lots.length}</span> פריטים · <span className="num">{fmt.num(photos)}</span> תמונות
            </span>
            {activeLots !== lots.length && <span><span className="num">{activeLots}</span> בשיוך פעיל</span>}
            {sold > 0 && <span><span className="num">{sold}</span> נמכרו</span>}
            {catalog.saleDate && <span>מכירה {fmt.date(catalog.saleDate)}</span>}
          </>
        }
        actions={
          <CatalogHeaderActions
            catalogId={catalog.id}
            catalogNumber={catalog.number}
            canImport={can(user.role, "lot.create")}
            canExport={can(user.role, "export.create")}
            canClose={can(user.role, "commercial.edit") && catalog.status !== "ARCHIVED"}
            activeLots={activeLots}
          />
        }
      >
        {lots.length > 0 && (
          <div className="mt-5 flex max-w-xl items-center gap-3">
            <Progress value={done} max={lots.length} className="h-2" />
            <span className="shrink-0 text-[13px] text-muted">
              <span className="num font-semibold text-ink">{Math.round((done / lots.length) * 100)}%</span> הושלמו ·{" "}
              <span className="num">{done}</span>/<span className="num">{lots.length}</span>
            </span>
          </div>
        )}
      </PageHeader>
      <LotsTable
        catalogId={catalog.id}
        catalogLabel={`${catalog.number} · ${catalog.name}`}
        lots={rows}
        initialStatus={status ?? "ALL"}
        otherCatalogs={otherCatalogs.map((c) => ({ id: c.id, number: c.number, name: c.name, house: c.auctionHouse.name }))}
        perms={{
          create: can(user.role, "lot.create"),
          edit: can(user.role, "lot.edit"),
          status: can(user.role, "lot.status"),
          capture: can(user.role, "photo.capture"),
          commercial: can(user.role, "commercial.edit"),
        }}
      />
    </>
  );
}
