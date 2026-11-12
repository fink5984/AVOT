import Link from "next/link";
import { z } from "zod";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { AI_ANALYSIS_STATUSES, COMMERCIAL_STATUSES, ITEM_REVIEW_STATUSES, ITEM_TYPES, PHOTO_STATUSES, PHYSICAL_STATUSES } from "@avot/shared";
import { db } from "@/server/db";
import { catalogScope } from "@/server/auth/houses";
import { ListControls, ListResults, type FilterGroup } from "@/components/list/list-controls";
import { parseEnumList, parseIdList } from "@/lib/search-text";
import { INVENTORY_VIEWS, inventoryBreakdown, inventoryCounts, listInventory, type InventoryFilters, type InventoryView } from "@/server/services/inventory";
import { listHouses } from "@/server/services/houses";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";
import { cn } from "@/lib/cn";
import { InventoryActions, InventoryTable } from "./inventory-client";

export const metadata = { title: "מלאי" };

const VIEW_LABEL: Record<InventoryView, string> = {
  all: "הכול",
  needs_review: "דורשים בדיקה אנושית",
  no_catalog: "ללא קטלוג",
  no_photos: "ללא צילום",
  no_location: "ללא מיקום",
  no_consignor: "ללא מפקיד",
  missing: "חסרים במחסן",
  awaiting_pick: "ממתינים לליקוט",
  unsold: "לא נמכרו",
};

interface Search {
  q?: string;
  view?: string;
  house?: string;
  sort?: string;
  page?: string;
  new?: string;
  /** "מצב פרטי הפריט" (a single value from an older link) */
  review?: string;
  // the filter window (several values are comma separated)
  photo?: string;
  rev?: string;
  ai?: string;
  comm?: string;
  phys?: string;
  type?: string;
  houses?: string;
  catalogs?: string;
  assigned?: string;
  wh?: string;
  col?: string;
  noloc?: string;
  consignors?: string;
  photos?: string;
  author?: string;
  place?: string;
  year?: string;
  addedFrom?: string;
  addedTo?: string;
  numFrom?: string;
  numTo?: string;
}

const OPTS = <T extends string>(values: readonly T[], label: Record<T, string>) => values.map((v) => ({ value: v, label: label[v] }));
const dayStart = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : undefined);
/** the number people see (10000035) or the short sequence number (35): both mean the same book */
const serialOf = (v?: string) => {
  const n = Number((v ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) && n > 0 ? (n >= 10_000_000 ? n - 10_000_000 : n) : undefined;
};

/**
 * Central inventory: every physical book, independent of house or catalog.
 * Desktop-first working table with filters, quick actions and bulk actions.
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requirePageUser("inventory.view");
  const sp = await searchParams;
  const view = z.enum(INVENTORY_VIEWS).catch("all").parse(sp.view ?? "all");
  const houses = can(user.role, "catalog.view") ? await listHouses(user) : [];
  const house = houses.find((h) => h.slug === sp.house);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const sort = (["updated", "number", "title"].includes(sp.sort ?? "") ? sp.sort : "updated") as "updated" | "number" | "title";
  const review = (ITEM_REVIEW_STATUSES as readonly string[]).includes(sp.review ?? "") ? sp.review : undefined;
  const canCatalogs = can(user.role, "catalog.view");
  const canConsignors = can(user.role, "consignor.view");
  // what the filter window offers: only things this user may see (catalogs of their houses, consignors if they may open them)
  const [catalogRows, consignorRows, warehouseRows] = await Promise.all([
    canCatalogs ? db.catalog.findMany({ where: { organizationId: user.organizationId, ...catalogScope(user) }, select: { id: true, number: true, name: true, auctionHouse: { select: { name: true } } }, orderBy: [{ saleDate: "desc" }, { createdAt: "desc" }], take: 300 }) : [],
    canConsignors ? db.consignor.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }) : [],
    db.warehouse.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true, zones: { where: { deletedAt: null }, select: { id: true, code: true, name: true }, orderBy: { sortOrder: "asc" } } }, orderBy: [{ isDefault: "desc" }, { code: "asc" }] }),
  ]);
  const filters: InventoryFilters = {
    photoStatuses: parseEnumList(sp.photo, PHOTO_STATUSES),
    reviewStatuses: parseEnumList(sp.rev, ITEM_REVIEW_STATUSES),
    aiStatuses: parseEnumList(sp.ai, AI_ANALYSIS_STATUSES),
    commercialStatuses: parseEnumList(sp.comm, COMMERCIAL_STATUSES),
    physicalStatuses: parseEnumList(sp.phys, PHYSICAL_STATUSES),
    itemTypes: parseEnumList(sp.type, ITEM_TYPES),
    houseIds: canCatalogs ? parseIdList(sp.houses).filter((id) => houses.some((h) => h.id === id)) : [],
    catalogIds: canCatalogs ? parseIdList(sp.catalogs).filter((id) => catalogRows.some((c) => c.id === id)) : [],
    assigned: sp.assigned === "yes" ? true : sp.assigned === "no" ? false : undefined,
    warehouseIds: parseIdList(sp.wh),
    zoneIds: parseIdList(sp.col),
    noLocation: sp.noloc === "1",
    consignorIds: canConsignors ? parseIdList(sp.consignors) : [],
    hasPhotos: sp.photos === "yes" ? true : sp.photos === "no" ? false : undefined,
    author: sp.author,
    printPlace: sp.place,
    printYear: sp.year,
    addedFrom: dayStart(sp.addedFrom),
    addedTo: (() => {
      const d = dayStart(sp.addedTo);
      return d ? new Date(d.getTime() + 24 * 3600 * 1000) : undefined;
    })(),
    serialFrom: serialOf(sp.numFrom),
    serialTo: serialOf(sp.numTo),
  };
  const [data, counts, bk] = await Promise.all([
    listInventory(user, { q: sp.q, view, houseId: house?.id, reviewStatus: review, filters, sort, page, pageSize: 100 }),
    inventoryCounts(user.organizationId),
    inventoryBreakdown(user.organizationId),
  ]);
  const groups: FilterGroup[] = [
    { kind: "multi", key: "photo", label: "צילום", section: "מצב הספר", options: OPTS(PHOTO_STATUSES, t.photoStatus) },
    { kind: "multi", key: "rev", label: "סקירת פרטים", section: "מצב הספר", options: OPTS(ITEM_REVIEW_STATUSES, t.reviewStatus) },
    { kind: "multi", key: "ai", label: "ניתוח AI", section: "מצב הספר", options: OPTS(AI_ANALYSIS_STATUSES, t.aiStatus) },
    { kind: "multi", key: "comm", label: "מצב מסחרי", section: "מצב הספר", options: OPTS(COMMERCIAL_STATUSES, t.commercialStatus) },
    { kind: "multi", key: "phys", label: "מצב פיזי", section: "מצב הספר", options: OPTS(PHYSICAL_STATUSES, t.physicalStatus) },
    ...(canCatalogs
      ? ([
          ...(houses.length > 1 ? [{ kind: "multi", key: "houses", label: "בית מכירות", section: "קטלוגים ומכירות", options: houses.map((h) => ({ value: h.id, label: h.name })) } as const] : []),
          { kind: "multi", key: "catalogs", label: "קטלוג", section: "קטלוגים ומכירות", searchable: true, options: catalogRows.map((c) => ({ value: c.id, label: `${c.auctionHouse.name} · ${c.number} · ${c.name}` })) },
          { kind: "choice", key: "assigned", label: "שיוך לקטלוג", section: "קטלוגים ומכירות", options: [{ value: "yes", label: "משויך לקטלוג" }, { value: "no", label: "לא משויך" }] },
        ] satisfies FilterGroup[])
      : []),
    { kind: "multi", key: "type", label: "סוג פריט", section: "נתוני ספר", options: OPTS(ITEM_TYPES, t.itemType) },
    { kind: "text", key: "author", label: "מחבר", section: "נתוני ספר", placeholder: "חלק מהשם" },
    { kind: "text", key: "place", label: "מקום הדפסה", section: "נתוני ספר" },
    { kind: "text", key: "year", label: "שנת הדפסה", section: "נתוני ספר", placeholder: "כפי שנרשמה, למשל תר״ח או 1848" },
    ...(warehouseRows.length > 0
      ? ([
          ...(warehouseRows.length > 1 ? [{ kind: "multi", key: "wh", label: "מחסן", section: "מחסן", options: warehouseRows.map((w) => ({ value: w.id, label: w.name })) } as const] : []),
          { kind: "multi", key: "col", label: "עמודה", section: "מחסן", searchable: true, options: warehouseRows.flatMap((w) => w.zones.map((z) => ({ value: z.id, label: warehouseRows.length > 1 ? `${w.name} · ${z.name?.trim() || `עמודה ${z.code}`}` : z.name?.trim() || `עמודה ${z.code}` }))) },
        ] satisfies FilterGroup[])
      : []),
    { kind: "flag", key: "noloc", label: "ללא מיקום במחסן", section: "מחסן" },
    ...(canConsignors ? ([{ kind: "multi", key: "consignors", label: "מפקיד", section: "נתונים נוספים", searchable: true, options: consignorRows.map((c) => ({ value: c.id, label: c.name })) }] satisfies FilterGroup[]) : []),
    { kind: "choice", key: "photos", label: "תמונות", section: "נתונים נוספים", options: [{ value: "yes", label: "עם תמונות" }, { value: "no", label: "בלי תמונות" }] },
    { kind: "range", key: "added", label: "תאריך הוספה", section: "נתונים נוספים", type: "date" },
    { kind: "range", key: "num", label: "טווח מספרי מלאי", section: "נתונים נוספים", type: "number" },
  ];
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const qs = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, q: sp.q, view: view === "all" ? undefined : view, house: sp.house, review, sort: sort === "updated" ? undefined : sort, new: undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `/inventory?${s}` : "/inventory";
  };

  return (
    <>
      <PageHeader
        title="מלאי"
        meta={
          <span>
            <span className="num" data-testid="active-count">{fmt.num(counts.all)}</span> ספרים במלאי הפעיל · מלאי משותף לכל בתי המכירות
            {can(user.role, "sales.view") && bk.soldBooks > 0 && (
              <>
                {" · "}
                <Link href="/sold" className="underline-offset-2 hover:underline" data-testid="sold-link">
                  <span className="num">{fmt.num(bk.soldBooks)}</span> ספרים שנמכרו ({fmt.num(bk.soldInHouse + bk.soldAwaitingPick + bk.soldPickedPacked)} עדיין במחסן)
                </Link>
              </>
            )}
          </span>
        }
        actions={<InventoryActions canCreate={can(user.role, "inventory.create")} canImport={can(user.role, "inventory.import")} />}
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="סינון מלאי" className="scrollbar-none flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-stone p-0.5">
            {INVENTORY_VIEWS.map((v) => (
              <Link
                key={v}
                href={qs({ view: v === "all" ? undefined : v, page: undefined })}
                aria-current={view === v ? "page" : undefined}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors",
                  view === v ? "bg-paper text-ink shadow-card ring-1 ring-rule" : "text-ink-2 hover:text-ink",
                )}
              >
                {VIEW_LABEL[v]}
                <span className={cn("num text-[12px]", view === v ? "text-muted" : "text-faint")}>{fmt.num(counts[v])}</span>
              </Link>
            ))}
          </nav>
        </div>
        <ListControls
          className="mt-3"
          placeholder="חיפוש: שם ספר, מחבר, מפקיד, מספר מלאי, ברקוד, קטלוג"
          searchLabel="חיפוש במלאי"
          groups={groups}
          resetKeys={["view", "review", "house"]}
          sort={{ defaultValue: "updated", options: [{ value: "updated", label: "עודכנו לאחרונה" }, { value: "number", label: "לפי מספר מלאי" }, { value: "title", label: "לפי שם" }] }}
        />

        <ListResults className="mt-1">

        <InventoryTable
          rows={data.items}
          total={data.total}
          perms={{
            capture: can(user.role, "photo.capture"),
            ai: can(user.role, "ai.analyze"),
            assign: can(user.role, "catalog.assign"),
            label: can(user.role, "label.print"),
            edit: can(user.role, "inventory.edit"),
            create: can(user.role, "inventory.create"),
            delete: can(user.role, "inventory.delete"),
            relocate: can(user.role, "inventory.relocate"),
            fulfil: can(user.role, "pick.fulfil"),
            consignors: can(user.role, "consignor.view"),
          }}
          defaultHouse={house?.slug ?? null}
          focusAdd={sp.new === "1"}
        />
        </ListResults>

        {pages > 1 && (
          <nav aria-label="דפים" className="mt-4 flex items-center justify-center gap-2 text-[13px]">
            {page > 1 && (
              <Link href={qs({ page: String(page - 1) })} className="rounded-md px-3 py-1.5 hover:bg-stone">
                הקודם
              </Link>
            )}
            <span className="text-muted">
              עמוד <span className="num">{page}</span> מתוך <span className="num">{pages}</span> · <span className="num">{fmt.num(data.total)}</span> ספרים
            </span>
            {page < pages && (
              <Link href={qs({ page: String(page + 1) })} className="rounded-md px-3 py-1.5 hover:bg-stone">
                הבא
              </Link>
            )}
          </nav>
        )}
      </PageBody>
    </>
  );
}
