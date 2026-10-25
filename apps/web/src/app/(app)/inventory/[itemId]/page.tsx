import Link from "next/link";
import { notFound } from "next/navigation";
import { Camera, MapPin } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { getItemDetail, itemProgress } from "@/server/services/inventory";
import { listAssets } from "@/server/services/assets";
import { toAssetDto } from "@/server/services/asset-dto";
import { actionLabel, describeData } from "@/server/services/activity";
import { ButtonLink } from "@/components/ui/button";
import { CommercialStatusBadge, PhotoStatusBadge, PhysicalStatusBadge } from "@/components/ui/badge";
import { PageHeader, Panel } from "@/components/ui/misc";
import { HouseMark } from "@/components/house-mark";
import { fmt, t } from "@/i18n";
import { Gallery } from "../../lots/[lotId]/gallery/gallery-client";
import { ItemActions } from "./item-client";

export async function generateMetadata({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await db.inventoryItem.findUnique({ where: { id: itemId }, select: { inventoryNumber: true, title: true } }).catch(() => null);
  return { title: item ? `${item.inventoryNumber} · ${item.title}` : "ספר" };
}

const MOVE_KIND: Record<string, string> = {
  STORE: "אוחסן",
  TRANSFER: "הועבר",
  PICK: "לוקט מהמדף",
  RETURN: "הוחזר למדף",
  COUNT_ADJUST: "תוקן בספירת מלאי",
  MANUAL: "תיקון ידני",
};
const DIMENSION: Record<string, string> = { PHOTO: "צילום", PHYSICAL: "מחסן", COMMERCIAL: "מסחרי" };
const statusName = (dim: string, s: string | null) =>
  !s ? "—" : dim === "PHOTO" ? (t.photoStatus as Record<string, string>)[s] ?? s : dim === "PHYSICAL" ? (t.physicalStatus as Record<string, string>)[s] ?? s : (t.commercialStatus as Record<string, string>)[s] ?? s;
// already shown through the status / movement rows of the timeline
const SKIP_AUDIT = new Set(["lot.status_changed", "inventory.photo_status", "lot.commercial_status", "warehouse.item_moved"]);

export default async function ItemPage({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<{ category?: string }> }) {
  const user = await requirePageUser("inventory.view");
  const { itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) notFound();
  const detail = await getItemDetail(user, itemId);
  if (!detail) notFound();
  const { item, lots, events, moves, audit, categoryCounts } = detail;
  const [assets, progress] = await Promise.all([listAssets(user.organizationId, item.id), itemProgress(item.id)]);
  const active = lots.find((l) => l.assignmentStatus === "ACTIVE");
  const openPick = item.pickTasks.find((p) => ["OPEN", "PICKED", "PACKED"].includes(p.status));
  const { category } = await searchParams;

  type Entry = { at: Date; text: string; detail?: string | null; who?: string | null; tone?: "move" | "status" | "audit" };
  const timeline: Entry[] = [
    ...events.map((e) => ({
      at: e.createdAt,
      tone: "status" as const,
      text: `${DIMENSION[e.dimension]}: ${e.fromStatus ? `${statusName(e.dimension, e.fromStatus)} ← ` : ""}${statusName(e.dimension, e.toStatus)}`,
      detail: e.reason,
      who: e.userName,
    })),
    ...moves.map((m) => ({
      at: m.occurredAt,
      tone: "move" as const,
      text: `${MOVE_KIND[m.kind] ?? m.kind}: ${m.from?.code ?? "—"} ← ${m.to?.code ?? "מחוץ למדף"}`,
      detail: m.note ?? (m.occurredAt.getTime() < m.createdAt.getTime() - 60_000 ? `סונכרן ב-${fmt.dateTime(m.createdAt)}` : null),
      who: m.userName,
    })),
  ];
  // consecutive captures collapse into one row
  for (const a of audit.filter((x) => !SKIP_AUDIT.has(x.action))) {
    const last = timeline[timeline.length - 1];
    if (a.action === "photo.captured" && last?.text.startsWith("צילם") && last.who === (a.user?.name ?? null) && Math.abs(last.at.getTime() - a.createdAt.getTime()) < 30 * 60_000) {
      const n = Number(last.text.match(/\d+/)?.[0] ?? 1) + 1;
      last.text = `צילם ${n} תמונות`;
      continue;
    }
    timeline.push({ at: a.createdAt, tone: "audit", text: a.action === "photo.captured" ? "צילם 1 תמונות" : actionLabel(a.action), detail: describeData(a.action, a.data), who: a.user?.name ?? null });
  }
  timeline.sort((x, y) => y.at.getTime() - x.at.getTime());

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
                <span className="num font-mono">{item.currentLocation.code}</span>
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
            <ItemActions
              item={{
                id: item.id,
                inventoryNumber: item.inventoryNumber,
                title: item.title,
                subtitle: item.subtitle,
                author: item.author,
                printPlace: item.printPlace,
                printYear: item.printYear,
                publisher: item.publisher,
                bibliographicNotes: item.bibliographicNotes,
                internalNotes: item.internalNotes,
                conditionNotes: item.conditionNotes,
                heightMm: item.heightMm,
                widthMm: item.widthMm,
                depthMm: item.depthMm,
                sizeCategory: item.sizeCategory,
                barcode: item.barcode,
                physicalStatus: item.physicalStatus,
                commercialStatus: item.commercialStatus,
                hasActiveLot: !!active,
                hasOpenPick: !!openPick,
              }}
              perms={perms}
            />
            {perms.capture && (
              <ButtonLink href={`/capture/${item.id}${category ? `?category=${category}` : ""}`} variant="capture" icon={<Camera />}>
                צילום
              </ButtonLink>
            )}
          </>
        }
      />

      <div className="grid items-start gap-6 px-4 pb-10 lg:px-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Gallery
          lot={{ id: item.id, lotNumber: item.serial, catalogId: item.id, catalogNumber: "INV", title: item.title, name: item.inventoryNumber }}
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

        <div className="space-y-4">
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
              <dt className="text-muted">קטגוריית גודל</dt>
              <dd>{t.bookSize[item.sizeCategory]}</dd>
              {dims && (
                <>
                  <dt className="text-muted">מידות</dt>
                  <dd className="num">{dims}</dd>
                </>
              )}
              {item.publisher && (
                <>
                  <dt className="text-muted">מדפיס / הוצאה</dt>
                  <dd>{item.publisher}</dd>
                </>
              )}
              {item.bibliographicNotes && (
                <>
                  <dt className="text-muted">ביבליוגרפיה</dt>
                  <dd className="whitespace-pre-line">{item.bibliographicNotes}</dd>
                </>
              )}
              {item.conditionNotes && (
                <>
                  <dt className="text-muted">מצב העותק</dt>
                  <dd className="whitespace-pre-line">{item.conditionNotes}</dd>
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

          <Panel title="היסטוריה">
            <ol className="max-h-[560px] divide-y divide-rule overflow-y-auto text-[13px]">
              {timeline.map((e, i) => (
                <li key={i} className="flex gap-3 px-5 py-2.5">
                  <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${e.tone === "move" ? "bg-info" : e.tone === "status" ? "bg-accent" : "bg-faint"}`} aria-hidden />
                  <div className="min-w-0">
                    <div>{e.text}</div>
                    {e.detail && <div className="text-[12px] text-muted">{e.detail}</div>}
                    <div className="text-[11.5px] text-faint">
                      {fmt.dateTime(e.at)}
                      {e.who && <> · {e.who}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}
