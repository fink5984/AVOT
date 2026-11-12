import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listConsignors } from "@/server/services/consignors";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { ListControls, ListResults } from "@/components/list/list-controls";
import { ConsignorsAddButton, ConsignorsTable } from "./consignors-client";

export const metadata = { title: "מפקידים" };

/** The people and companies that deposit books for sale. Independent of any catalog or auction house. */
export default async function ConsignorsPage({ searchParams }: { searchParams: Promise<{ q?: string; archived?: string }> }) {
  const user = await requirePageUser("consignor.view");
  const sp = await searchParams;
  const showArchived = sp.archived === "1";
  const data = await listConsignors(user, { q: sp.q, includeArchived: showArchived, limit: 500 });

  return (
    <>
      <PageHeader
        title="מפקידים"
        meta={
          <span>
            <span className="num">{fmt.num(data.total)}</span> {sp.q ? "תוצאות" : "מפקידים"} · כל ספר חדש משויך למפקיד
          </span>
        }
        actions={can(user.role, "consignor.create") ? <ConsignorsAddButton /> : undefined}
      />
      <PageBody>
        <ListControls
          className="mb-4"
          placeholder="חיפוש לפי שם, טלפון או דוא״ל"
          searchLabel="חיפוש מפקידים"
          groups={[{ kind: "flag", key: "archived", label: "כולל מפקידים בארכיון", section: "מפקידים" }]}
        />
        <ListResults>
        <ConsignorsTable consignors={data.consignors} canManage={can(user.role, "consignor.manage")} searching={!!sp.q} />
        </ListResults>
      </PageBody>
    </>
  );
}
