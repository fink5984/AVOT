import Link from "next/link";
import { notFound } from "next/navigation";
import { Camera, MapPin } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can, canUser } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { getItemDetail, itemProgress } from "@/server/services/inventory";
import { listAssets } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { ButtonLink } from "@/components/ui/button";
import { CommercialStatusBadge, PhotoStatusBadge, PhysicalStatusBadge, ReviewStatusBadge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/misc";
import { HouseMark } from "@/components/house-mark";
import { fmt, t } from "@/i18n";
import { Gallery } from "../../lots/[lotId]/gallery/gallery-client";
import { InventoryItemActions } from "@/components/inventory/item-actions";
import { PhotographerNotes } from "@/components/photographer-notes";
import { locationLabel } from "@/server/services/location-label";
import { getAiState } from "@/server/services/ai-analysis";
import { BookWorkspace } from "@/components/inventory/book-workspace";
import { BookHistory } from "@/components/inventory/book-history";
import { SalePanel } from "@/components/sales/sale-panel";
import { legacySaleBlockReason } from "@/server/services/legacy-sales";

export async function generateMetadata({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await db.inventoryItem.findUnique({ where: { id: itemId }, select: { inventoryNumber: true, title: true } }).catch(() => null);
  return { title: item ? `${item.inventoryNumber} · ${item.title}` : "ספר" };
}

export default async function ItemPage({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<{ category?: string }> }) {
  const user = await requirePageUser("inventory.view");
  const { itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) notFound();
  const detail = await getItemDetail(user, itemId);
  if (!detail) notFound();
  const { item, lots, events, moves, audit, categoryCounts } = detail;
  const [assets, progress, ai] = await Promise.all([listAssets(user.organizationId, item.id), itemProgress(item.id), getAiState(user, item.id)]);
  const active = lots.find((l) => l.assignmentStatus === "ACTIVE");
  const openPick = item.pickTasks.find((p) => ["OPEN", "PICKED", "PACKED"].includes(p.status));
  const { category } = await searchParams;

  const perms = {
    capture: can(user.role, "photo.capture"),
    edit: can(user.role, "inventory.edit"),
    assign: can(user.role, "catalog.assign"),
    label: can(user.role, "label.print"),
    pick: can(user.role, "pick.manage"),
    move: can(user.role, "warehouse.manage"),
  };
  const dims = [item.heightMm, item.widthMm, item.depthMm].some(Boolean) ? `${item.heightMm ?? "?"}×${item.widthMm ?? "?"}×${item.depthMm ?? "?"} מ״מ` : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "מלאי", href: "/inventory" }, { label: item.inventoryNumber }]}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <span className="num font-mono font-semibold text-ink">{item.inventoryNumber}</span>
            {item.barcode !== item.inventoryNumber && <span className="num font-mono text-[12px]">ברקוד {item.barcode}</span>}
            <PhotoStatusBadge status={item.photoStatus} />
            <PhysicalStatusBadge status={item.physicalStatus} />
            <CommercialStatusBadge status={item.commercialStatus} />
            <ReviewStatusBadge status={item.reviewStatus} />
          </span>
        }
        title={item.title}
        meta={
          <>
            {[item.author, item.printPlace, item.printYear].filter(Boolean).length > 0 && <span>{[item.author, item.printPlace, item.printYear].filter(Boolean).join(" · ")}</span>}
            <span>
              <span className="num">{item.photoCount}</span> תמונות
            </span>
            {item.currentLocation ? (
              <Link href={`/warehouse/locations/${item.currentLocation.id}`} className="inline-flex items-center gap-1 hover:underline">
                <MapPin className="size-3.5" />
                <span>{locationLabel(item.currentLocation)}</span>
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 text-warn">
                <MapPin className="size-3.5" />
                ללא מיקום במחסן
              </span>
            )}
          </>
        }
        actions={
          <>
            <InventoryItemActions
              context="page"
              subject={{
                id: item.id,
                inventoryNumber: item.inventoryNumber,
                title: item.title,
                physicalStatus: item.physicalStatus,
                commercialStatus: item.commercialStatus,
                hasLocation: !!item.currentLocation,
                assignment: active ? "active" : null,
                hasOpenPick: !!openPick,
                captureHref: `/capture/${item.id}${category ? `?category=${category}` : ""}`,
                ai: { aiStatus: item.aiStatus, hasAiResult: item.aiCompletedAt !== null, aiError: item.aiError, photoStatus: item.photoStatus },
                approverEmail: can(user.role, "ai.reanalyze.approve") ? user.email : undefined,
                legacyBlock: can(user.role, "sale.legacy") ? await legacySaleBlockReason(db, user.organizationId, item.id) : null,
              }}
              perms={{ ...perms, relocate: perms.move, fulfil: can(user.role, "pick.fulfil"), delete: can(user.role, "inventory.delete"), ai: can(user.role, "ai.analyze"), legacy: can(user.role, "sale.legacy") }}
            />
          </>
        }
      />

      <div className="grid items-start gap-6 px-4 pb-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
        <BookWorkspace
          user={user}
          detail={detail}
          ai={ai}
          gallery={
            <Gallery
              lot={{ id: item.id, lotNumber: Number(item.serial), catalogId: item.id, catalogNumber: "INV", title: item.title, name: item.inventoryNumber }}
              initialAssets={assets.map(toAssetDto)}
              initialCategory="ALL"
              progress={progress}
              siblings={[]}
              userId={user.userId}
              perms={{
                organize: can(user.role, "photo.organize"),
                remove: can(user.role, "photo.delete"),
                download: can(user.role, "photo.download"),
                capture: perms.capture,
                mark: can(user.role, "lot.status"),
              }}
            />
          }
        />
        </div>

        <div className="space-y-4">
          <SalePanel user={user} itemId={item.id} />
          <Panel title="שיוכים לקטלוגים">
            {lots.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-muted">הספר עדיין לא שויך לקטלוג.</p>
            ) : (
              <ul className="divide-y divide-rule text-[13px]">
                {lots.map((l) =>
                  l.hidden ? (
                    <li key={l.id} className="px-5 py-3 text-muted">
                      שיוך לבית מכירות אחר ({t.assignment[l.assignmentStatus]})
                    </li>
                  ) : (
                    <li key={l.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <HouseMark name={l.catalog.auctionHouse.name} color={l.catalog.auctionHouse.accentColor} />
                        <CommercialStatusBadge status={l.commercialStatus} />
                      </div>
                      <Link href={`/lots/${l.id}`} className="mt-1 block font-medium hover:underline">
                        קטלוג <span className="num">{l.catalog.number}</span> · פריט <span className="num">{l.lotNumber}</span>
                      </Link>
                      {l.mergedIntoLotId ? (
                        <div className="text-[12px] font-medium text-accent">אוחד ללוט משולב · נשמר כהיסטוריה</div>
                      ) : l.bookCount > 1 ? (
                        <div className="text-[12px] font-medium text-accent">לוט משולב · <span className="num">{l.bookCount}</span> ספרים נמכרים יחד</div>
                      ) : null}
                      <div className="text-[12px] text-muted">
                        {l.catalog.name} · {fmt.date(l.assignedAt)}
                        {l.endedAt && <> – {fmt.date(l.endedAt)}</>} · {t.assignment[l.assignmentStatus]}
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Panel>

          <Panel title="פרטים">
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 px-5 py-4 text-[13px]">
              <dt className="text-muted">מפקיד</dt>
              <dd>
                {item.consignor ? (
                  can(user.role, "consignor.view") ? (
                    <Link href={`/consignors/${item.consignor.id}`} className="font-medium hover:underline">
                      {item.consignor.name}
                    </Link>
                  ) : (
                    item.consignor.name
                  )
                ) : (
                  <span className="text-warn">ללא מפקיד{perms.edit ? " — אפשר להשלים בעריכת הספר" : ""}</span>
                )}
              </dd>
              <dt className="text-muted">קטגוריית גודל</dt>
              <dd>{t.bookSize[item.sizeCategory]}</dd>
              {dims && (
                <>
                  <dt className="text-muted">מידות</dt>
                  <dd className="num">{dims}</dd>
                </>
              )}
              {item.internalNotes && (
                <>
                  <dt className="text-muted">הערות פנימיות</dt>
                  <dd className="whitespace-pre-line">{item.internalNotes}</dd>
                </>
              )}
              <dt className="text-muted">תמונות</dt>
              <dd>
                {Object.entries(categoryCounts)
                  .map(([c, n]) => `${t.categoryShort[c as keyof typeof t.categoryShort]} ${n}`)
                  .join(" · ")}
              </dd>
              <dt className="text-muted">נקלט</dt>
              <dd>{fmt.dateTime(item.receivedAt)}</dd>
            </dl>
          </Panel>

          <PhotographerNotes
            key={item.id}
            itemId={item.id}
            initialText={item.photographerNotes ?? ""}
            initialRev={item.photographerNotesRev === null ? null : Number(item.photographerNotesRev)}
            canEdit={can(user.role, "photographerNotes.edit")}
            variant="panel"
            collapsible
          />

          {item.pickTasks.length > 0 && (
            <Panel title="ליקוט ומשלוח">
              <ul className="divide-y divide-rule text-[13px]">
                {item.pickTasks.map((p) => (
                  <li key={p.id} className="px-5 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{t.pickStatus[p.status]}</span>
                      <span className="text-[12px] text-muted">{fmt.dateTime(p.createdAt)}</span>
                    </div>
                    <div className="text-[12px] text-muted">{p.reason}</div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <BookHistory detail={detail} />
        </div>
      </div>
    </>
  );
}
