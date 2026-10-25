import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listPickTasks } from "@/server/services/picking";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { PickTable } from "./picking-client";

export const metadata = { title: "ליקוט ומשלוח" };

/** Pick → pack → ship. Open tasks in walking order (zone / shelf / cell). Picking itself is done by scanning on the handheld. */
export default async function PickingPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requirePageUser("warehouse.view");
  const all = (await searchParams).all === "1";
  const tasks = await listPickTasks(user.organizationId, { status: all ? "all" : "open" });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "מחסן", href: "/warehouse" }, { label: "ליקוט ומשלוח" }]}
        title="ליקוט ומשלוח"
        meta={<span>ליקוט מתבצע בסריקת הספר במסופון (מצב ליקוט). כאן מסמנים אריזה ומשלוח.</span>}
      />
      <PageBody>
        <PickTable tasks={tasks} showAll={all} perms={{ fulfil: can(user.role, "pick.fulfil"), manage: can(user.role, "pick.manage") }} />
      </PageBody>
    </>
  );
}
