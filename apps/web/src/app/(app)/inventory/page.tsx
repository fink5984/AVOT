import Link from "next/link";
import { z } from "zod";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { INVENTORY_VIEWS, inventoryCounts, listInventory, type InventoryView } from "@/server/services/inventory";
import { listHouses } from "@/server/services/houses";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { cn } from "@/lib/cn";
import { InventoryActions, InventoryTable } from "./inventory-client";

export const metadata = { title: "מלאי" };

const VIEW_LABEL: Record<InventoryView, string> = {
  all: "הכול",
  no_catalog: "ללא קטלוג",
  no_photos: "ללא צילום",
  no_location: "ללא מיקום",
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
}

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
  const [data, counts] = await Promise.all([
    listInventory(user, { q: sp.q, view, houseId: house?.id, sort, page, pageSize: 100 }),
    inventoryCounts(user.organizationId),
  ]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const qs = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged = { q: sp.q, view: view === "all" ? undefined : view, house: sp.house, sort: sort === "updated" ? undefined : sort, ...patch };
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
            <span className="num">{fmt.num(counts.all)}</span> ספרים · מלאי משותף לכל בתי המכירות
          </span>
        }
        actions={<InventoryActions canCreate={can(user.role, "inventory.create")} canImport={can(user.role, "inventory.import")} autoOpen={sp.new === "1"} />}
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
          <form action="/inventory" className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto">
            {view !== "all" && <input type="hidden" name="view" value={view} />}
            <input
              type="search"
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="חיפוש: שם, מחבר, ITM-…, ברקוד"
              aria-label="חיפוש במלאי"
              className="h-9 min-w-0 flex-1 rounded-md border border-rule-strong bg-paper px-3 text-[13.5px] shadow-card focus:border-ink/40 focus:outline-none focus:ring-[3px] focus:ring-ink/6 sm:w-64"
            />
            {houses.length > 0 && (
              <select name="house" defaultValue={sp.house ?? ""} aria-label="בית מכירות" className="h-9 rounded-md border border-rule-strong bg-paper px-2 text-[13px] shadow-card">
                <option value="">כל בתי המכירות</option>
                {houses.map((h) => (
                  <option key={h.slug} value={h.slug}>
                    משויך ל{h.name}
                  </option>
                ))}
              </select>
            )}
            <select name="sort" defaultValue={sort} aria-label="מיון" className="h-9 rounded-md border border-rule-strong bg-paper px-2 text-[13px] shadow-card">
              <option value="updated">עודכנו לאחרונה</option>
              <option value="number">לפי מספר מלאי</option>
              <option value="title">לפי שם</option>
            </select>
            <button className="h-9 rounded-md bg-ink px-3.5 text-[13px] font-medium text-paper">סינון</button>
          </form>
        </div>

        <InventoryTable
          rows={data.items}
          total={data.total}
          perms={{
            capture: can(user.role, "photo.capture"),
            assign: can(user.role, "catalog.assign"),
            label: can(user.role, "label.print"),
            edit: can(user.role, "inventory.edit"),
            create: can(user.role, "inventory.create"),
            delete: can(user.role, "inventory.delete"),
            relocate: can(user.role, "inventory.relocate"),
          }}
          defaultHouse={house?.slug ?? null}
        />

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
