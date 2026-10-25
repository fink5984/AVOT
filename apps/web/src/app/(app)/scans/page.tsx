import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listScanEvents } from "@/server/services/scanning";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { ScanLog } from "./scans-client";

export const metadata = { title: "סריקות" };

/** Every handheld scan with its server outcome; late-synced scans with contradicting data wait here for a decision. */
export default async function ScansPage({ searchParams }: { searchParams: Promise<{ open?: string; result?: string }> }) {
  const user = await requirePageUser("warehouse.view");
  const sp = await searchParams;
  const events = await listScanEvents(user.organizationId, { onlyOpen: sp.open === "1", result: sp.result, take: 300 });
  const open = await listScanEvents(user.organizationId, { onlyOpen: true, take: 1000 });
  return (
    <>
      <PageHeader title="סריקות" meta={<span><span className="num">{open.length}</span> ממתינות להחלטה</span>} />
      <PageBody>
        <ScanLog events={events} filter={sp.open === "1" ? "open" : (sp.result ?? "all")} canResolve={can(user.role, "warehouse.manage")} />
      </PageBody>
    </>
  );
}
