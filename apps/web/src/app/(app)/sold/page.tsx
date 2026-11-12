import { requirePageUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { catalogScope } from "@/server/auth/houses";
import { listSold } from "@/server/services/sales-views";
import { PageBody, PageHeader, Stat } from "@/components/ui/misc";
import { formatUsd } from "@/lib/money";
import { fmt } from "@/i18n";
import { SoldTable } from "./sold-table";

export const metadata = { title: "נמכרו" };

/** Every lot that sold, across all the sales the user may see: buyer, price, and the three independent states. */
export default async function SoldPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser("sales.view");
  const sp = await searchParams;
  const financial = ["NONE", "UNPAID", "PARTIAL", "PAID"].includes(sp.financial ?? "") ? (sp.financial as "UNPAID") : undefined;
  const data = await listSold(user, { q: sp.q, catalogId: /^[0-9a-f-]{36}$/i.test(sp.catalogId ?? "") ? sp.catalogId : undefined, houseId: /^[0-9a-f-]{36}$/i.test(sp.houseId ?? "") ? sp.houseId : undefined, financial, stage: sp.stage });
  const [catalogs, houses] = await Promise.all([
    db.catalog.findMany({ where: { organizationId: user.organizationId, ...catalogScope(user) }, select: { id: true, number: true, name: true, auctionHouse: { select: { name: true } } }, orderBy: [{ saleDate: "desc" }, { createdAt: "desc" }], take: 200 }),
    db.auctionHouse.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
  ]);
  const s = data.summary;
  return (
    <>
      <PageHeader title="נמכרו" meta={<span>לוטים שנמכרו בכל המכירות המורשות · מספר הלוטים נפרד ממספר הספרים הפיזיים</span>} />
      <PageBody>
        <div className="mb-5 grid grid-cols-2 divide-x-reverse divide-rule overflow-hidden rounded-xl border border-rule bg-paper shadow-card sm:grid-cols-3 lg:grid-cols-6" data-testid="sold-summary">
          <Stat label="לוטים שנמכרו" value={fmt.num(s.soldLots)} sub={`${fmt.num(s.soldBooks)} ספרים פיזיים`} />
          <Stat label="סכום מכירות (פטיש)" value={formatUsd(s.hammerTotal)} />
          <Stat label="לקוחות" value={fmt.num(s.customers)} />
          <Stat label="ממתינים לתשלום" value={fmt.num(s.awaitingPayment)} tone="danger" sub="לוטים" />
          <Stat label="ממתינים למשלוח" value={fmt.num(s.awaitingShipment)} tone="warn" sub="לוטים" />
          <Stat label="נשלחו" value={fmt.num(s.shipped)} tone="green" sub="לוטים" />
        </div>
        <SoldTable
          rows={data.rows}
          truncated={data.truncated}
          catalogs={catalogs.map((c) => ({ id: c.id, label: `${c.auctionHouse.name} · ${c.number} · ${c.name}` }))}
          houses={houses}
          filters={{ q: sp.q ?? "", catalogId: sp.catalogId ?? "", houseId: sp.houseId ?? "", financial: sp.financial ?? "", stage: sp.stage ?? "" }}
          perms={{
            release: canUser(user, "pick.release"),
            releaseUnpaid: canUser(user, "pick.release.unpaid"),
            ship: canUser(user, "shipment.prepare"),
            customers: canUser(user, "customer.view"),
          }}
        />
      </PageBody>
    </>
  );
}
