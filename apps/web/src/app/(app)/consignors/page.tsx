import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { listConsignors } from "@/server/services/consignors";
import { PageBody, PageHeader } from "@/components/ui/misc";
import { fmt } from "@/i18n";
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
        <form action="/consignors" className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="חיפוש לפי שם, טלפון או דוא״ל"
            aria-label="חיפוש מפקידים"
            className="h-9 min-w-0 flex-1 rounded-md border border-rule-strong bg-paper px-3 text-[13.5px] shadow-card focus:border-ink/40 focus:outline-none focus:ring-[3px] focus:ring-ink/6 sm:w-80 sm:flex-none"
          />
          <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
            <input type="checkbox" name="archived" value="1" defaultChecked={showArchived} className="size-4 accent-[var(--color-ink)]" />
            הצג גם מפקידים בארכיון
          </label>
          <button className="h-9 rounded-md bg-ink px-3.5 text-[13px] font-medium text-paper">חיפוש</button>
        </form>
        <ConsignorsTable consignors={data.consignors} canManage={can(user.role, "consignor.manage")} searching={!!sp.q} />
      </PageBody>
    </>
  );
}
