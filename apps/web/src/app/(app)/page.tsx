import Link from "next/link";
import { BookOpen, Camera, ChevronLeft, Plus, ScanLine } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { listCatalogs } from "@/server/services/catalogs";
import { inventoryCounts } from "@/server/services/inventory";
import { loadCaptureContext } from "@/server/services/capture-context";
import { ButtonLink } from "@/components/ui/button";
import { CatalogStatusBadge, PhotoStatusBadge } from "@/components/ui/badge";
import { HouseMark } from "@/components/house-mark";
import { EmptyState, PageBody, PageHeader, Progress, Stat } from "@/components/ui/misc";
import { fmt, t } from "@/i18n";

export const metadata = { title: "לוח עבודה" };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requirePageUser();
  const { denied } = await searchParams;
  const org = user.organizationId;
  const seesCatalogs = can(user.role, "catalog.view");

  const [counts, photoCount, catalogs, attention, lastSession, workPref, conflicts, openPicks] = await Promise.all([
    inventoryCounts(org),
    db.photoAsset.count({ where: { organizationId: org, deletedAt: null } }),
    seesCatalogs ? listCatalogs(user, { sort: "updated" }) : Promise.resolve([]),
    db.inventoryItem.findMany({
      where: { organizationId: org, photoStatus: { in: ["NEEDS_RESHOOT", "PENDING_REVIEW"] } },
      orderBy: [{ photoStatus: "asc" }, { updatedAt: "desc" }],
      take: 8,
      select: { id: true, inventoryNumber: true, title: true, photoStatus: true, primaryAssetId: true },
    }),
    db.captureSession.findFirst({ where: { userId: user.userId }, orderBy: { lastActivityAt: "desc" } }),
    db.userPreference.findUnique({ where: { userId_key: { userId: user.userId, key: "workPosition" } } }),
    can(user.role, "warehouse.manage") ? db.barcodeScanEvent.count({ where: { organizationId: org, result: "CONFLICT", resolvedAt: null } }) : Promise.resolve(0),
    db.pickTask.count({ where: { organizationId: org, status: { in: ["OPEN", "PICKED", "PACKED"] } } }),
  ]);
  const openCatalogs = catalogs.filter((c) => c.status !== "ARCHIVED");

  // the last capture position may be a catalog lot or an inventory book
  const canCapture = can(user.role, "photo.capture");
  const resumeId = (workPref?.value as { lotId?: string } | null)?.lotId ?? lastSession?.lotId ?? lastSession?.inventoryItemId;
  const resumeCategory = (workPref?.value as { category?: string } | null)?.category ?? lastSession?.activeCategory;
  const resume = canCapture && resumeId ? await loadCaptureContext(org, resumeId).catch(() => null) : null;
  const resumeThumb = resume?.assets.find((a) => a.isPrimary)?.thumbUrl ?? resume?.assets.find((a) => a.thumbUrl)?.thumbUrl ?? null;

  const inv = (view: string) => `/inventory?view=${view}`;

  return (
    <>
      <PageHeader
        title={`שלום, ${user.name.split(" ")[0]}`}
        meta={<span>{fmt.date(new Date())}</span>}
        actions={
          <>
            {can(user.role, "warehouse.operate") && (
              <ButtonLink href="/scanner" icon={<ScanLine />}>
                מסופון
              </ButtonLink>
            )}
            {can(user.role, "inventory.create") && (
              <ButtonLink href="/inventory?new=1" variant="primary" icon={<Plus />}>
                הוספת ספר
              </ButtonLink>
            )}
          </>
        }
      />

      <PageBody className="space-y-6">
        {denied && (
          <p className="rounded-lg bg-warn-soft px-4 py-3 text-[13.5px] text-warn" role="alert">
            אין לך הרשאה למסך שביקשת.
          </p>
        )}

        {resume && (
          <section className="relative overflow-hidden rounded-xl bg-ink text-paper shadow-pop">
            <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
              <div className="flex min-w-0 flex-1 items-center gap-5">
                <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-white/8 ring-1 ring-white/10">
                  {resumeThumb ? (
                    <img src={resumeThumb} alt="" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full items-center justify-center text-white/30">
                      <BookOpen className="size-7 stroke-[1.4]" />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-white/55">המשך מהנקודה האחרונה</div>
                  <div className="mt-1 truncate text-[20px] font-semibold tracking-[-0.01em]">{resume.lot.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-white/60">
                    <span className="num font-mono">{resume.item.inventoryNumber}</span>
                    {resume.target === "lot" && (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          קטלוג <span className="num">{resume.catalog.number}</span> · פריט <span className="num">{resume.lot.lotNumber}</span>
                        </span>
                      </>
                    )}
                    {resumeCategory && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t.category[resumeCategory as keyof typeof t.category]}</span>
                      </>
                    )}
                    <span aria-hidden>·</span>
                    <span>
                      <span className="num">{resume.assets.length}</span> תמונות
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <ButtonLink href={`/inventory/${resume.item.id}`} className="border-white/15 bg-white/8 text-paper shadow-none hover:border-white/25 hover:bg-white/14">
                  לספר
                </ButtonLink>
                <ButtonLink href={`/capture/${resume.lot.id}${resumeCategory ? `?category=${resumeCategory}` : ""}`} variant="capture" icon={<Camera />}>
                  המשך צילום
                </ButtonLink>
              </div>
            </div>
          </section>
        )}

        {/* the numbers each role acts on */}
        <div className="card grid grid-cols-2 gap-px overflow-hidden bg-rule p-0 sm:grid-cols-4 lg:grid-cols-7 [&>*]:bg-paper">
          <Stat href="/inventory" label="ספרים במלאי" value={fmt.num(counts.all)} sub={`${fmt.num(photoCount)} תמונות`} />
          {user.role !== "WAREHOUSE" && <Stat href={inv("no_photos")} label="ללא צילום" value={fmt.num(counts.no_photos)} tone={counts.no_photos ? "info" : undefined} />}
          {user.role !== "PHOTOGRAPHER" && <Stat href={inv("no_location")} label="ללא מיקום במחסן" value={fmt.num(counts.no_location)} tone={counts.no_location ? "warn" : undefined} />}
          {seesCatalogs && user.role !== "PHOTOGRAPHER" && <Stat href={inv("no_catalog")} label="ללא קטלוג" value={fmt.num(counts.no_catalog)} />}
          {seesCatalogs && user.role !== "PHOTOGRAPHER" && <Stat href={inv("unsold")} label="לא נמכרו" value={fmt.num(counts.unsold)} />}
          {user.role !== "PHOTOGRAPHER" && <Stat href="/warehouse/picking" label="ליקוט / אריזה / משלוח" value={fmt.num(openPicks)} tone={openPicks ? "accent" : undefined} />}
          {user.role !== "PHOTOGRAPHER" && <Stat href={inv("missing")} label="חסרים / בבירור" value={fmt.num(counts.missing)} tone={counts.missing ? "danger" : undefined} />}
        </div>

        {conflicts > 0 && (
          <Link href="/scans?open=1" className="flex items-center gap-3 rounded-lg bg-danger-soft px-4 py-3 text-[13.5px] text-danger ring-1 ring-danger/20 hover:bg-danger-soft/70">
            <ScanLine className="size-4" />
            <span>
              <span className="num font-semibold">{conflicts}</span> סריקות מחסן ממתינות להחלטה (סנכרון מאוחר עם נתונים סותרים)
            </span>
            <ChevronLeft className="ms-auto size-4" />
          </Link>
        )}

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          {seesCatalogs && (
            <section className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[16px] font-semibold">קטלוגים פתוחים</h2>
                <Link href="/houses" className="flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink">
                  בתי מכירות <ChevronLeft className="size-4" />
                </Link>
              </div>
              {openCatalogs.length === 0 ? (
                <div className="card">
                  <EmptyState icon={<BookOpen />} title="אין קטלוגים פתוחים">
                    קטלוג שייך לבית מכירות (אבות או טבין). ספרים מהמלאי משויכים אליו עם התמונות שלהם.
                  </EmptyState>
                </div>
              ) : (
                <div className="card overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[13.5px]">
                    <thead>
                      <tr className="border-b border-rule text-[12.5px] text-muted">
                        <th className="w-28 px-4 py-2.5 text-start font-medium">בית מכירות</th>
                        <th className="w-20 px-3 py-2.5 text-start font-medium">קטלוג</th>
                        <th className="px-3 py-2.5 text-start font-medium">שם</th>
                        <th className="w-24 px-3 py-2.5 text-start font-medium">סטטוס</th>
                        <th className="w-48 px-3 py-2.5 text-start font-medium">צילום הושלם</th>
                        <th className="w-24 px-3 py-2.5 text-start font-medium">מכירה</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {openCatalogs.slice(0, 10).map((c) => (
                        <tr key={c.id} className="relative hover:bg-stone-2">
                          <td className="px-4 py-2.5">
                            <HouseMark name={c.auctionHouse.name} color={c.auctionHouse.accentColor} />
                          </td>
                          <td className="num px-3 py-2.5 font-semibold">{c.number}</td>
                          <td className="max-w-0 px-3 py-2.5">
                            <Link href={`/catalogs/${c.id}`} className="block truncate font-medium after:absolute after:inset-0">
                              {c.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5">
                            <CatalogStatusBadge status={c.status} />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <Progress value={c.completedCount} max={c.lotCount} className="w-24" />
                              <span className="num text-[12.5px] text-muted">
                                {c.completedCount}/{c.lotCount}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{c.saleDate ? fmt.date(c.saleDate) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section className="min-w-0">
            <h2 className="mb-3 text-[16px] font-semibold">צילום — דורש טיפול</h2>
            <div className="card overflow-hidden">
              {attention.length === 0 ? (
                <p className="px-5 py-8 text-center text-[13.5px] text-muted">אין ספרים שממתינים לבדיקה או לצילום חוזר.</p>
              ) : (
                <ul className="divide-y divide-rule">
                  {attention.map((i) => (
                    <li key={i.id}>
                      <Link href={`/inventory/${i.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-stone-2">
                        <span className="size-10 shrink-0 overflow-hidden rounded-md bg-stone">
                          {i.primaryAssetId && <img src={`/api/assets/${i.primaryAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{i.title}</span>
                          <span className="num block text-start font-mono text-[12px] text-muted">{i.inventoryNumber}</span>
                        </span>
                        <PhotoStatusBadge status={i.photoStatus} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </PageBody>
    </>
  );
}
