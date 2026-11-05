import Link from "next/link";
import { notFound } from "next/navigation";
import { Library, Mail, Phone } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { getConsignor } from "@/server/services/consignors";
import { listInventory } from "@/server/services/inventory";
import { Badge, PhotoStatusBadge } from "@/components/ui/badge";
import { EmptyState, PageBody, PageHeader, Panel } from "@/components/ui/misc";
import { HouseMark } from "@/components/house-mark";
import { fmt } from "@/i18n";
import { ConsignorCardActions } from "../consignor-card-actions";

export const metadata = { title: "כרטיס מפקיד" };
const PAGE_SIZE = 100;

/** A consignor's card: details, how many books, and every book deposited with its photo state and current catalog. */
export default async function ConsignorCardPage({ params, searchParams }: { params: Promise<{ consignorId: string }>; searchParams: Promise<{ page?: string }> }) {
  const user = await requirePageUser("consignor.view");
  const { consignorId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(consignorId)) notFound();
  const consignor = await getConsignor(user, consignorId).catch((e) => (e instanceof AppError && e.code === "NOT_FOUND" ? null : Promise.reject(e)));
  if (!consignor) notFound();
  const page = Math.max(1, Number((await searchParams).page ?? 1) || 1);
  const books = await listInventory(user, { consignorId, sort: "number", page, pageSize: PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(books.total / PAGE_SIZE));
  const link = (p: number) => `/consignors/${consignorId}${p > 1 ? `?page=${p}` : ""}`;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "מפקידים", href: "/consignors" }, { label: consignor.name }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {consignor.name}
            {consignor.archived && <Badge tone="neutral">בארכיון</Badge>}
          </span>
        }
        meta={
          <>
            <span>
              <span className="num">{fmt.num(consignor.bookCount)}</span> ספרים משויכים
            </span>
            {consignor.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="size-3.5" />
                <bdi className="num">{consignor.phone}</bdi>
              </span>
            )}
            {consignor.email && (
              <span className="inline-flex items-center gap-1">
                <Mail className="size-3.5" />
                <bdi>{consignor.email}</bdi>
              </span>
            )}
          </>
        }
        actions={can(user.role, "consignor.manage") ? <ConsignorCardActions consignor={consignor} /> : undefined}
      />
      <PageBody className="space-y-4">
        {consignor.notes && (
          <Panel title="הערות">
            <p className="whitespace-pre-line px-5 py-4 text-[13.5px]">{consignor.notes}</p>
          </Panel>
        )}
        <div className="card overflow-hidden">
          {books.items.length === 0 ? (
            <EmptyState icon={<Library />} title="אין ספרים משויכים למפקיד זה">
              ספרים משויכים למפקיד בעת הקליטה למלאי, או בעריכת פרטי הספר.
            </EmptyState>
          ) : (
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-rule text-[12.5px] text-muted">
                  <th className="w-32 px-4 py-2.5 text-start font-medium">מספר מלאי</th>
                  <th className="px-2 py-2.5 text-start font-medium">שם הספר</th>
                  <th className="hidden w-36 px-2 py-2.5 text-start font-medium sm:table-cell">מצב צילום</th>
                  <th className="hidden w-52 px-2 py-2.5 text-start font-medium md:table-cell">קטלוג נוכחי</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {books.items.map((b) => (
                  <tr key={b.id} className="relative transition-colors hover:bg-stone-2">
                    <td className="num px-4 py-2 font-mono">
                      <Link href={`/inventory/${b.id}`} className="after:absolute after:inset-0">
                        {b.inventoryNumber}
                      </Link>
                    </td>
                    <td className="max-w-0 truncate px-2 py-2 font-medium">{b.title}</td>
                    <td className="hidden px-2 py-2 sm:table-cell">
                      <PhotoStatusBadge status={b.photoStatus} />
                    </td>
                    <td className="hidden px-2 py-2 md:table-cell">
                      {b.assignment === null ? (
                        <span className="text-faint">ללא קטלוג</span>
                      ) : "hidden" in b.assignment ? (
                        <span className="text-muted">משויך לבית מכירות אחר</span>
                      ) : (
                        <div>
                          <HouseMark name={b.assignment.house.name} color={b.assignment.house.accentColor} className="text-[12.5px]" />
                          <span className="block text-[12.5px] text-ink-2">
                            קטלוג <span className="num">{b.assignment.catalog.number}</span> · פריט <span className="num">{b.assignment.lotNumber}</span>
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {pages > 1 && (
          <nav aria-label="דפים" className="flex items-center justify-center gap-2 text-[13px]">
            {page > 1 && (
              <Link href={link(page - 1)} className="rounded-md px-3 py-1.5 hover:bg-stone">
                הקודם
              </Link>
            )}
            <span className="text-muted">
              עמוד <span className="num">{page}</span> מתוך <span className="num">{pages}</span>
            </span>
            {page < pages && (
              <Link href={link(page + 1)} className="rounded-md px-3 py-1.5 hover:bg-stone">
                הבא
              </Link>
            )}
          </nav>
        )}
      </PageBody>
    </>
  );
}
