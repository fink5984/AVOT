import { requirePageUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { catalogScope } from "@/server/auth/houses";
import { shippingOverview } from "@/server/services/shipments";
import { PageBody, PageHeader, Stat } from "@/components/ui/misc";
import { fmt } from "@/i18n";
import { ShipmentsClient } from "./shipments-client";

export const metadata = { title: "משלוחים" };

/** Shipping is managed per customer: customers, lots, physical books and shipments are counted apart. */
export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser("shipment.prepare");
  const sp = await searchParams;
  const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
  const data = await shippingOverview(user, { q: sp.q, houseId: uuid(sp.houseId), catalogId: uuid(sp.catalogId), financial: sp.financial, stage: sp.stage, onlyPartial: sp.partial === "1", onlyReady: sp.ready === "1" });
  const [catalogs, houses, recent] = await Promise.all([
    db.catalog.findMany({ where: { organizationId: user.organizationId, ...catalogScope(user) }, select: { id: true, number: true, name: true, auctionHouse: { select: { name: true } } }, orderBy: [{ saleDate: "desc" }], take: 200 }),
    db.auctionHouse.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
    db.shipment.findMany({ where: { organizationId: user.organizationId, status: { in: ["DRAFT", "PACKED"] } }, orderBy: { createdAt: "desc" }, take: 30, include: { customer: { select: { id: true, name: true } }, items: { where: { isActive: true }, select: { purchaseId: true } } } }),
  ]);
  const t = data.totals;
  return (
    <>
      <PageHeader title="משלוחים" meta={<span>ניהול לפי לקוח · משלוח נחשב ״נשלח״ רק כשהספרים יצאו פיזית</span>} />
      <PageBody>
        <div className="mb-5 grid grid-cols-2 divide-x-reverse divide-rule overflow-hidden rounded-xl border border-rule bg-paper shadow-card sm:grid-cols-4 lg:grid-cols-8" data-testid="shipping-summary">
          <Stat label="ספרים ממתינים" value={fmt.num(t.waitingBooks)} sub="פיזיים" tone="warn" />
          <Stat label="לוטים ממתינים" value={fmt.num(t.waitingLots)} />
          <Stat label="לקוחות עם משלוח פתוח" value={fmt.num(t.customersOpen)} />
          <Stat label="נארזו" value={fmt.num(t.packedBooks)} sub="ספרים" />
          <Stat label="נשלחו" value={fmt.num(t.shippedBooks)} sub="ספרים" tone="green" />
          <Stat label="משלוחים שהושלמו" value={fmt.num(t.completedShipments)} />
          {canUser(user, "sales.view") && <Stat label="ממתינים בגלל תשלום" value={fmt.num(t.customersBlockedByPayment)} sub="לקוחות" tone="danger" />}
          <Stat label="משלוחים חלקיים" value={fmt.num(t.partialShipments)} />
        </div>
        <ShipmentsClient
          rows={data.rows}
          open={recent.map((s) => ({ id: s.id, number: s.number, status: s.status, customer: s.customer.name, lots: new Set(s.items.map((i) => i.purchaseId)).size, books: s.items.length }))}
          catalogs={catalogs.map((c) => ({ id: c.id, label: `${c.auctionHouse.name} · ${c.number} · ${c.name}` }))}
          houses={houses}
          filters={{ q: sp.q ?? "", houseId: sp.houseId ?? "", catalogId: sp.catalogId ?? "", financial: sp.financial ?? "", stage: sp.stage ?? "", partial: sp.partial === "1", ready: sp.ready === "1" }}
          canCustomers={canUser(user, "customer.view")}
        />
      </PageBody>
    </>
  );
}
