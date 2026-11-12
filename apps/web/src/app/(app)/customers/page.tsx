import { requirePageUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { listCustomers } from "@/server/services/sales-views";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { CustomersClient } from "./customers-client";

export const metadata = { title: "לקוחות" };

/** The people who BUY at the auction. Not the consignors (who deposit books): that is a separate list. */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  const user = await requirePageUser("customer.view");
  const sp = await searchParams;
  const filter = (["all", "owing", "waiting", "needsDetails"] as const).find((f) => f === sp.filter) ?? "all";
  const rows = await listCustomers(user, { q: sp.q, filter });
  return (
    <>
      <PageHeader title="לקוחות" meta={<span><span className="num">{fmt.num(rows.length)}</span> לקוחות קונים · נפרדים ממפקידים</span>} />
      <PageBody>
        <CustomersClient rows={rows} q={sp.q ?? ""} filter={filter} canEdit={canUser(user, "customer.edit")} />
      </PageBody>
    </>
  );
}
