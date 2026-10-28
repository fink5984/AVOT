import { notFound } from "next/navigation";
import Link from "next/link";
import { Camera, ChevronLeft, ChevronRight, Library, MapPin } from "lucide-react";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@avot/shared";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { lotProgress } from "@/server/services/lots";
import { listAssets } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { ButtonLink } from "@/components/ui/button";
import { CommercialStatusBadge, LotStatusBadge } from "@/components/ui/badge";
import { canSeeHouse } from "@/server/auth/houses";
import { HouseMark } from "@/components/house-mark";
import { PageHeader } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { Gallery } from "./gallery/gallery-client";
import { LotControls, LotDetails, LotMenu, LotNotes } from "./lot-client";
import { LotDisplayPanel } from "./lot-display";
import { locationInclude, locationLabel } from "@/server/services/location-label";

export async function generateMetadata({ params }: { params: Promise<{ lotId: string }> }) {
  const { lotId } = await params;
  const lot = await db.lot.findUnique({ where: { id: lotId }, select: { lotNumber: true, title: true } }).catch(() => null);
  return { title: lot ? `${lot.lotNumber} · ${lot.title}` : "פריט" };
}

/**
 * One screen per book: status, photo requirements, the photos themselves
 * (organise, download, import) and the book's details — no separate gallery page.
 */
export default async function LotPage({ params, searchParams }: { params: Promise<{ lotId: string }>; searchParams: Promise<{ category?: string }> }) {
  const user = await requirePageUser("catalog.view");
  const { lotId } = await params;
  const { category } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(lotId)) notFound();
  const lot = await db.lot.findFirst({
    where: { id: lotId, organizationId: user.organizationId },
    include: { catalog: { include: { auctionHouse: true } }, item: { include: { currentLocation: { include: locationInclude } } } },
  });
  if (!lot || !canSeeHouse(user, lot.catalog.auctionHouseId)) notFound();

  const [progress, prev, next, assets, siblings] = await Promise.all([
    lotProgress(lot.id),
    db.lot.findFirst({ where: { catalogId: lot.catalogId, lotNumber: { lt: lot.lotNumber } }, orderBy: { lotNumber: "desc" }, select: { id: true, lotNumber: true } }),
    db.lot.findFirst({ where: { catalogId: lot.catalogId, lotNumber: { gt: lot.lotNumber } }, orderBy: { lotNumber: "asc" }, select: { id: true, lotNumber: true } }),
    listAssets(user.organizationId, lot.inventoryItemId),
    db.lot.findMany({ where: { catalogId: lot.catalogId, id: { not: lot.id } }, select: { id: true, lotNumber: true, title: true }, orderBy: { lotNumber: "asc" } }),
  ]);

  const unmet = progress.filter((p) => !p.satisfied).map((p) => t.category[p.category]);
  const canCapture = can(user.role, "photo.capture");
  const canEdit = can(user.role, "lot.edit");
  const initialCategory = PHOTO_CATEGORIES.includes(category as PhotoCategory) ? (category as PhotoCategory) : "ALL";
  const byline = [lot.author, lot.printPlace, lot.printYear].filter(Boolean).join(" · ");
  const formValue = {
    id: lot.id,
    lotNumber: lot.lotNumber,
    title: lot.title,
    subtitle: lot.subtitle,
    author: lot.author,
    printYear: lot.printYear,
    printPlace: lot.printPlace,
    shortDescription: lot.shortDescription,
    description: lot.description,
    internalNotes: lot.internalNotes,
    requirements: lot.item.requirements as never,
  };

  const pagerBtn = "h-9 gap-1 px-2.5";
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: lot.catalog.auctionHouse.name, href: `/houses/${lot.catalog.auctionHouse.slug}` },
          { label: `קטלוג ${lot.catalog.number} · ${lot.catalog.name}`, href: `/catalogs/${lot.catalogId}` },
        ]}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <HouseMark name={lot.catalog.auctionHouse.name} color={lot.catalog.auctionHouse.accentColor} />
            <span>
              פריט <span className="num font-semibold text-ink">{lot.lotNumber}</span>
            </span>
            <LotStatusBadge status={lot.status} />
            <CommercialStatusBadge status={lot.commercialStatus} />
          </span>
        }
        title={lot.title}
        meta={
          <>
            {lot.subtitle && <span>{lot.subtitle}</span>}
            {byline && <span>{byline}</span>}
            <span>
              <span className="num">{lot.photoCount}</span> תמונות
            </span>
            <Link href={`/inventory/${lot.inventoryItemId}`} className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-ink hover:underline">
              <Library className="size-3.5" />
              <span className="num font-mono">{lot.item.inventoryNumber}</span>
            </Link>
            {lot.item.currentLocation && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" />
                <span>{locationLabel(lot.item.currentLocation)}</span>
              </span>
            )}
          </>
        }
        actions={
          <>
            {(prev || next) && (
            <div className="flex items-center rounded-md border border-rule-strong bg-paper shadow-card">
              <ButtonLink
                href={prev ? `/lots/${prev.id}` : "#"}
                variant="ghost"
                aria-disabled={!prev}
                className={cn(pagerBtn, "rounded-e-none", !prev && "pointer-events-none opacity-35")}
                title="פריט קודם"
                icon={<ChevronRight />}
              >
                <span className="num">{prev?.lotNumber ?? "—"}</span>
              </ButtonLink>
              <span className="h-5 w-px bg-rule" aria-hidden />
              <ButtonLink
                href={next ? `/lots/${next.id}` : "#"}
                variant="ghost"
                aria-disabled={!next}
                className={cn(pagerBtn, "rounded-s-none", !next && "pointer-events-none opacity-35")}
                title="פריט הבא"
              >
                <span className="num">{next?.lotNumber ?? "—"}</span>
                <ChevronLeft />
              </ButtonLink>
            </div>
            )}
            <LotMenu lot={formValue} catalogId={lot.catalogId} canEdit={canEdit} canAudit={can(user.role, "audit.view")} />
            {canCapture && (
              <ButtonLink href={`/capture/${lot.id}${initialCategory !== "ALL" ? `?category=${initialCategory}` : ""}`} variant="capture" icon={<Camera />}>
                צילום
              </ButtonLink>
            )}
          </>
        }
      >
        <LotControls lotId={lot.id} status={lot.status} unmet={unmet} nextLotId={next?.id ?? null} canStatus={can(user.role, "lot.status")} />
        {lot.assignmentStatus === "ENDED" && (
          <p className="mt-4 rounded-lg bg-warn-soft px-4 py-2.5 text-[13px] text-warn" role="status">
            השיוך לקטלוג זה הסתיים ({fmt.date(lot.endedAt)}{lot.endReason ? ` · ${lot.endReason}` : ""}). הפרטים נשמרים כהיסטוריה; הספר עצמו מנוהל במסך{" "}
            <Link href={`/inventory/${lot.inventoryItemId}`} className="font-medium underline">
              המלאי
            </Link>
            .
          </p>
        )}
      </PageHeader>

      <div className="grid items-start gap-6 px-4 pb-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <Gallery
          lot={{ id: lot.id, lotNumber: lot.lotNumber, catalogId: lot.catalogId, catalogNumber: lot.catalog.number, title: lot.title }}
          initialAssets={assets.map(toAssetDto)}
          initialCategory={initialCategory}
          progress={progress}
          siblings={siblings}
          userId={user.userId}
          perms={{
            organize: can(user.role, "photo.organize"),
            remove: can(user.role, "photo.delete"),
            download: can(user.role, "photo.download"),
            capture: canCapture,
            mark: can(user.role, "lot.status"),
          }}
        />

        <div className="space-y-4">
          <LotDetails lot={formValue} catalogId={lot.catalogId} canEdit={canEdit} />
          <LotNotes lotId={lot.id} initial={lot.internalNotes ?? ""} canEdit={canEdit} />
          {lot.photoCount > 0 && <LotDisplayPanel lotId={lot.id} canEdit={canEdit} />}
          <p className="px-1 text-[12px] leading-relaxed text-faint">
            נוצר {fmt.dateTime(lot.createdAt)} · עודכן {fmt.dateTime(lot.updatedAt)}
            {lot.completedAt && <> · הושלם {fmt.dateTime(lot.completedAt)}</>}
          </p>
        </div>
      </div>
    </>
  );
}
