import { Download } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { jobDto } from "@/server/services/job-dto";
import { EmptyState, PageBody, PageHeader } from "@/components/ui/misc";
import { ExportsTable } from "./exports-client";

export const metadata = { title: "ייצוא והורדות" };

export default async function ExportsPage() {
  const user = await requirePageUser("photo.download");
  const jobs = await db.job.findMany({
    where: { organizationId: user.organizationId, type: "EXPORT_ZIP", ...(user.role === "ADMIN" ? {} : { createdById: user.userId }) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const lotIds = [...new Set(jobs.map((j) => (j.payload as { lotId?: string }).lotId).filter((x): x is string => !!x))];
  const catIds = [...new Set(jobs.map((j) => (j.payload as { catalogId?: string }).catalogId).filter((x): x is string => !!x))];
  const [lots, catalogs] = await Promise.all([
    db.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, title: true } }),
    db.catalog.findMany({ where: { id: { in: catIds } }, select: { id: true, number: true, name: true } }),
  ]);

  return (
    <>
      <PageHeader title="הורדות" meta={<span>קובצי ZIP נבנים ברקע ונשמרים 48 שעות. הורדה חדשה מתחילה ממסך הספר או הקטלוג.</span>} />
      <PageBody>
        {jobs.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Download />} title="אין עבודות ייצוא">
              הורידו ספר, קטגוריה או קטלוג שלם מהגלריה או ממסך הקטלוג.
            </EmptyState>
          </div>
        ) : (
          <ExportsTable
            initial={jobs.map(jobDto)}
            lots={lots}
            catalogs={catalogs}
          />
        )}
      </PageBody>
    </>
  );
}
