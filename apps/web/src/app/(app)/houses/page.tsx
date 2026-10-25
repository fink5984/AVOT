import Link from "next/link";
import { requirePageUser } from "@/server/auth/principal";
import { houseSummaries } from "@/server/services/houses";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";

export const metadata = { title: "בתי מכירות" };

/** Both auction houses share one inventory; each has its own catalogs, lots, descriptions and settings. */
export default async function HousesPage() {
  const user = await requirePageUser("catalog.view");
  const houses = await houseSummaries(user);
  return (
    <>
      <PageHeader title="בתי מכירות" meta={<span>המלאי משותף; הקטלוגים, הפריטים והתיאורים נפרדים לכל בית מכירות</span>} />
      <PageBody>
        <div className="card overflow-hidden">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-rule text-[12.5px] text-muted">
                <th className="px-5 py-3 text-start font-medium">בית מכירות</th>
                <th className="w-32 px-3 py-3 text-start font-medium">קטלוגים</th>
                <th className="w-32 px-3 py-3 text-start font-medium">פעילים</th>
                <th className="w-40 px-3 py-3 text-start font-medium">פריטים בשיוך פעיל</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {houses.map((h) => (
                <tr key={h.id} className="relative hover:bg-stone-2">
                  <td className="px-5 py-4">
                    <Link href={`/houses/${h.slug}`} className="flex items-center gap-3 after:absolute after:inset-0">
                      {h.logoUrl ? (
                        <img src={h.logoUrl} alt="" className="size-9 rounded-md object-contain ring-1 ring-rule" />
                      ) : (
                        <span className="flex size-9 items-center justify-center rounded-md font-display text-[18px] font-bold text-white" style={{ background: h.accentColor }} aria-hidden>
                          {h.name.slice(0, 1)}
                        </span>
                      )}
                      <span>
                        <span className="block text-[16px] font-semibold">{h.name}</span>
                        {h.nameEn && <span className="block text-[12px] text-muted" dir="ltr">{h.nameEn}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className="num px-3 py-4">{fmt.num(h.catalogs)}</td>
                  <td className="num px-3 py-4">{fmt.num(h.activeCatalogs)}</td>
                  <td className="num px-3 py-4">{fmt.num(h.activeLots)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageBody>
    </>
  );
}
