import Link from "next/link";
import { ChevronLeft, ChevronRight, Layers } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { listCombinedLotAssets } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { getLotComposition } from "@/server/services/lot-members";
import { locationInclude, locationLabel } from "@/server/services/location-label";
import { ButtonLink } from "@/components/ui/button";
import { Badge, CommercialStatusBadge, LotStatusBadge } from "@/components/ui/badge";
import { HouseMark } from "@/components/house-mark";
import { PageHeader, Panel } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { cn } from "@/lib/cn";
import { LotMenu, LotNotes } from "../lot-client";
import { BooksPanel, type LotBook } from "./books-panel";
import { CombinedGallery, type GalleryAsset } from "./combined-gallery";
import { LotAiPanel } from "./lot-ai-panel";
import { SharedTextCard } from "./shared-text";
import { FulfilmentCard } from "./fulfilment-card";

const EVENT_LABEL: Record<string, string> = { MERGE: "איחוד ללוט", ADD: "הוספת ספרים", REMOVE: "הסרת ספר", DISSOLVE: "פירוק הלוט", REORDER: "שינוי סדר הספרים" };

type Lot = NonNullable<Awaited<ReturnType<typeof loadLot>>>;
async function loadLot(lotId: string, orgId: string) {
  return db.lot.findFirst({ where: { id: lotId, organizationId: orgId }, include: { catalog: { include: { auctionHouse: true } } } });
}
export type CombinedLot = Lot;

/**
 * The lot page of a COMBINED lot (several books sold as one). The same page and the same components as an ordinary lot
 * where they fit; the new parts are "הספרים בלוט", the shared gallery, the shared description with its AI button and the
 * lot's composition history.
 */
export async function CombinedLotView({ lot, user }: { lot: Lot; user: Awaited<ReturnType<typeof requirePageUser>> }) {
  const [composition, gallery, prev, next] = await Promise.all([
    getLotComposition(lot.id),
    listCombinedLotAssets(user.organizationId, lot),
    db.lot.findFirst({ where: { catalogId: lot.catalogId, mergedIntoLotId: null, lotNumber: { lt: lot.lotNumber } }, orderBy: { lotNumber: "desc" }, select: { id: true, lotNumber: true } }),
    db.lot.findFirst({ where: { catalogId: lot.catalogId, mergedIntoLotId: null, lotNumber: { gt: lot.lotNumber } }, orderBy: { lotNumber: "asc" }, select: { id: true, lotNumber: true } }),
  ]);
  const itemIds = composition.members.map((m) => m.inventoryItemId);
  const [items, consignor, actors] = await Promise.all([
    db.inventoryItem.findMany({ where: { id: { in: itemIds } }, include: { currentLocation: { include: locationInclude } } }),
    db.consignor.findFirst({ where: { id: composition.members[0]?.item.consignorId ?? undefined, organizationId: user.organizationId }, select: { id: true, name: true } }),
    db.user.findMany({ where: { id: { in: composition.history.map((h) => h.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const actorName = new Map(actors.map((a) => [a.id, a.name]));
  const books: LotBook[] = composition.members.map((m) => {
    const i = itemById.get(m.inventoryItemId)!;
    return {
      itemId: i.id,
      inventoryNumber: i.inventoryNumber,
      title: i.title,
      author: i.author,
      thumbAssetId: i.primaryAssetId,
      reviewStatus: i.reviewStatus,
      physicalStatus: i.physicalStatus,
      locationLabel: i.currentLocation ? locationLabel(i.currentLocation) : null,
      photoCount: i.photoCount,
    };
  });
  const mainAssetId = lot.primaryAssetId ?? gallery.find((a) => a.isPrimary)?.id ?? gallery.find((a) => !a.hidden && a.thumbKey)?.id ?? null;
  const canAssign = can(user.role, "catalog.assign");
  const open = lot.assignmentStatus === "ACTIVE" && lot.commercialStatus === "ASSIGNED" && lot.catalog.status !== "ARCHIVED";
  const blockedReason = !open
    ? lot.catalog.status === "ARCHIVED"
      ? "הקטלוג בארכיון - לא ניתן לשנות את הרכב הלוט."
      : lot.assignmentStatus !== "ACTIVE"
        ? "השיוך לקטלוג הסתיים - הרכב הלוט נשמר כהיסטוריה ואינו ניתן לשינוי."
        : "הלוט כבר הוצע או נמכר - לא ניתן לשנות את הרכבו."
    : !canAssign
      ? "אין לך הרשאה לשנות את הרכב הלוט."
      : null;
  const canEdit = can(user.role, "lot.edit");
  const canCapture = can(user.role, "photo.capture");
  const sold = lot.commercialStatus === "SOLD";
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
            <Badge tone="accent" dot={false}>
              <Layers className="size-3" aria-hidden /> לוט משולב · <span className="num">{books.length}</span> ספרים
            </Badge>
            <LotStatusBadge status={lot.status} />
            <CommercialStatusBadge status={lot.commercialStatus} />
          </span>
        }
        title={lot.title}
        meta={
          <>
            {consignor && (
              <span>
                מפקיד: <span className="font-medium text-ink-2">{consignor.name}</span>
              </span>
            )}
            <span>
              <span className="num">{lot.photoCount}</span> תמונות
            </span>
            {composition.absorbed.length > 0 && (
              <span>
                אוחדו הפריטים: <span className="num">{composition.absorbed.map((a) => a.lotNumber).join(", ")}</span>
              </span>
            )}
          </>
        }
        actions={
          <>
            {(prev || next) && (
              <div className="flex items-center rounded-md border border-rule-strong bg-paper shadow-card">
                <ButtonLink href={prev ? `/lots/${prev.id}` : "#"} variant="ghost" aria-disabled={!prev} className={cn(pagerBtn, "rounded-e-none", !prev && "pointer-events-none opacity-35")} title="פריט קודם" icon={<ChevronRight />}>
                  <span className="num">{prev?.lotNumber ?? "—"}</span>
                </ButtonLink>
                <span className="h-5 w-px bg-rule" aria-hidden />
                <ButtonLink href={next ? `/lots/${next.id}` : "#"} variant="ghost" aria-disabled={!next} className={cn(pagerBtn, "rounded-s-none", !next && "pointer-events-none opacity-35")} title="פריט הבא">
                  <span className="num">{next?.lotNumber ?? "—"}</span>
                  <ChevronLeft />
                </ButtonLink>
              </div>
            )}
            <LotMenu
              lot={{ id: lot.id, lotNumber: lot.lotNumber, title: lot.title, subtitle: null, author: null, printYear: null, printPlace: null, shortDescription: null, internalNotes: null }}
              catalogId={lot.catalogId}
              canEdit={false}
              canAudit={can(user.role, "audit.view")}
            />
          </>
        }
      >
        {lot.assignmentStatus === "ENDED" && (
          <p className="mt-4 rounded-lg bg-warn-soft px-4 py-2.5 text-[13px] text-warn" role="status">
            השיוך לקטלוג זה הסתיים ({fmt.date(lot.endedAt)}
            {lot.endReason ? ` · ${lot.endReason}` : ""}). הפרטים נשמרים כהיסטוריה.
          </p>
        )}
      </PageHeader>

      <div className="grid items-start gap-6 px-4 pb-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <BooksPanel lotId={lot.id} lotNumber={lot.lotNumber} books={books} canChange={open && canAssign} blockedReason={blockedReason} canCapture={canCapture} />
          <CombinedGallery
            key={`gallery-${lot.compositionVersion}-${gallery.length}`}
            lotId={lot.id}
            lotNumber={lot.lotNumber}
            initial={gallery.map((a) => ({ ...toAssetDto(a), hidden: a.hidden, book: a.book })) as GalleryAsset[]}
            books={books.map((b) => ({ itemId: b.itemId, inventoryNumber: b.inventoryNumber, title: b.title }))}
            canEdit={canEdit}
            canDownload={can(user.role, "photo.download")}
          />
          <LotAiPanel
            key={`ai-${lot.compositionVersion}-${lot.descriptionNeedsUpdate}-${lot.aiDescriptionRunId ?? ""}`}
            lotId={lot.id} canGenerate={can(user.role, "ai.analyze") && lot.assignmentStatus === "ACTIVE"} canApply={can(user.role, "ai.apply") && open} initialNeedsUpdate={lot.descriptionNeedsUpdate} />
        </div>

        <div className="space-y-4">
          <SharedTextCard
            lotId={lot.id}
            title={lot.title}
            shortDescription={lot.shortDescription}
            description={lot.description}
            mainAssetId={mainAssetId}
            bookCount={books.length}
            consignor={consignor}
            canViewConsignor={can(user.role, "consignor.view")}
            canEdit={canEdit}
          />
          {sold && <FulfilmentCard lotId={lot.id} />}
          <LotNotes lotId={lot.id} initial={lot.internalNotes ?? ""} canEdit={canEdit} />
          <Panel title="היסטוריית הרכב הלוט">
            {composition.history.length === 0 ? (
              <p className="px-4 py-3 text-[12.5px] text-muted">אין שינויים בהרכב.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {composition.history.map((h) => (
                  <li key={h.id} className="px-4 py-2.5 text-[12.5px]">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="font-medium">{EVENT_LABEL[h.kind] ?? h.kind}</span>
                      <span className="text-muted">{fmt.dateTime(h.createdAt)}</span>
                      {h.userId && actorName.get(h.userId) && <span className="text-muted">· {actorName.get(h.userId)}</span>}
                    </div>
                    <div className="num text-muted">{(h.itemIds as string[]).length} ספרים</div>
                  </li>
                ))}
              </ul>
            )}
            {composition.absorbed.length > 0 && (
              <p className="border-t border-rule px-4 py-2.5 text-[12px] text-muted">
                פריטים שאוחדו ללוט זה נשמרו כהיסטוריה:{" "}
                {composition.absorbed.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && ", "}
                    <Link href={`/lots/${a.id}`} className="num underline">
                      {a.lotNumber}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </Panel>
          <p className="px-1 text-[12px] leading-relaxed text-faint">
            נוצר {fmt.dateTime(lot.createdAt)} · עודכן {fmt.dateTime(lot.updatedAt)}
          </p>
        </div>
      </div>
    </>
  );
}
