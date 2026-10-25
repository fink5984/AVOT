import Link from "next/link";
import { redirect } from "next/navigation";
import { Search } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { globalSearch } from "@/server/services/search";
import { LotStatusBadge, CatalogStatusBadge, PhotoStatusBadge } from "@/components/ui/badge";
import { EmptyState, PageBody, PageHeader, Panel } from "@/components/ui/misc";

export const metadata = { title: "חיפוש" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requirePageUser("inventory.view");
  const q = ((await searchParams).q ?? "").trim().slice(0, 200);
  const r = q ? await globalSearch(user, q) : null;
  // scanned tag / label → straight to the book, lot or shelf
  if (r?.directItemId) redirect(`/inventory/${r.directItemId}`);
  if (r?.directLotId) redirect(`/lots/${r.directLotId}`);
  if (r?.directLocationId) redirect(`/warehouse/locations/${r.directLocationId}`);

  return (
    <>
      <PageHeader title="חיפוש" meta={q ? <span>תוצאות עבור ״{q}״</span> : <span>חיפוש לפי שם ספר, מחבר, מקום או שנת דפוס, מספר פריט (למשל 37 או 3/37) או סריקת תווית</span>} />
      <PageBody className="space-y-6">
        <form className="flex max-w-xl gap-2" action="/search">
          <input
            name="q"
            defaultValue={q}
            autoFocus
            type="search"
            placeholder="למשל: נועם אלימלך, ליוורנו, 3/37"
            className="h-10 min-w-0 flex-1 rounded-md border border-rule-strong bg-paper px-3.5 text-[14px] shadow-card focus:border-ink/50 focus:outline-none focus:ring-[3px] focus:ring-ink/8"
            aria-label="מילות חיפוש"
          />
          <button className="h-10 rounded-md bg-ink px-5 text-[13.5px] font-medium text-paper hover:bg-[#2d2b28]">חיפוש</button>
        </form>
        {r && r.items.length > 0 && (
          <Panel title={`ספרים במלאי (${r.items.length}${r.items.length === 20 ? "+" : ""})`}>
            <ul className="divide-y divide-rule">
              {r.items.map((i) => (
                <li key={i.id}>
                  <Link href={`/inventory/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13.5px] hover:bg-stone-2">
                    <span className="num font-mono text-[12.5px] text-muted">{i.inventoryNumber}</span>
                    <span className="font-medium">{i.title}</span>
                    {i.author && <span className="text-muted">{i.author}</span>}
                    <span className="ms-auto">
                      <PhotoStatusBadge status={i.photoStatus} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {r && r.items.length === 0 && r.lots.length === 0 && r.catalogs.length === 0 && (
          <div className="card">
            <EmptyState icon={<Search />} title="לא נמצאו תוצאות">
              נסו חלק משם הספר, את שם המחבר או את מספר הפריט.
            </EmptyState>
          </div>
        )}
        {r && r.catalogs.length > 0 && (
          <Panel title={`קטלוגים (${r.catalogs.length})`}>
            <ul className="divide-y divide-rule">
              {r.catalogs.map((c) => (
                <li key={c.id}>
                  <Link href={`/catalogs/${c.id}`} className="flex items-center gap-3 px-5 py-3 text-[13.5px] hover:bg-stone-2">
                    <span className="num w-14 font-semibold">{c.number}</span>
                    <span className="flex-1">{c.name}</span>
                    <CatalogStatusBadge status={c.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {r && r.lots.length > 0 && (
          <Panel title={`פריטים (${r.lots.length}${r.lots.length === 50 ? "+" : ""})`}>
            <ul className="divide-y divide-rule">
              {r.lots.map((l) => (
                <li key={l.id}>
                  <Link href={`/lots/${l.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13.5px] hover:bg-stone-2">
                    <span className="w-28 shrink-0 text-[12px] text-muted">
                      קטלוג {l.catalog.number} · <span className="num font-semibold text-ink">{l.lotNumber}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{l.title}</span>
                      {(l.author || l.printPlace || l.printYear) && <span className="ms-2 text-[12px] text-muted">{[l.author, l.printPlace, l.printYear].filter(Boolean).join(" · ")}</span>}
                    </span>
                    <span className="num text-[12px] text-muted">{l.photoCount} תמונות</span>
                    <LotStatusBadge status={l.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </PageBody>
    </>
  );
}
