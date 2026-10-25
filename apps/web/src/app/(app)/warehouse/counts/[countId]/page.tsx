import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { countReport } from "@/server/services/counting";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { CountReview } from "./count-client";

export const metadata = { title: "ספירת מלאי" };

const STATUS: Record<string, string> = { OPEN: "בספירה", REVIEW: "ממתינה לאישור", APPROVED: "אושרה", CANCELLED: "בוטלה" };

/** Discrepancy report. Nothing changes until a manager approves the selected corrections. */
export default async function CountPage({ params }: { params: Promise<{ countId: string }> }) {
  const user = await requirePageUser("warehouse.view");
  const { countId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(countId)) notFound();
  const report = await countReport(user.organizationId, countId).catch(() => null);
  if (!report) notFound();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "מחסן", href: "/warehouse" }, { label: "ספירת מלאי" }]}
        title={`ספירת מלאי · ${report.session.zone ?? "כל המחסן"}`}
        meta={
          <>
            <span>{STATUS[report.session.status]}</span>
            <span>{fmt.dateTime(report.session.startedAt)}</span>
            <span>
              <span className="num">{report.visited.length}</span> מיקומים נספרו · <span className="num">{report.matched}</span> תואמים
            </span>
          </>
        }
      />
      <PageBody>
        <CountReview report={report} canApprove={can(user.role, "warehouse.manage") && (report.session.status === "REVIEW" || report.session.status === "OPEN")} />
      </PageBody>
    </>
  );
}
