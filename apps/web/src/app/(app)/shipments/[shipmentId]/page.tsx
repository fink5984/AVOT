import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { getShipment } from "@/server/services/shipments";
import { PageHeader } from "@/components/ui/misc";
import { ShipmentBadge } from "@/components/sales/status";
import { ShipmentClient } from "./shipment-client";

export const metadata = { title: "משלוח" };

export default async function ShipmentPage({ params }: { params: Promise<{ shipmentId: string }> }) {
  const user = await requirePageUser("shipment.prepare");
  const { shipmentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(shipmentId)) notFound();
  const s = await getShipment(user, shipmentId).catch(() => null);
  if (!s) notFound();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "משלוחים", href: "/shipments" }, { label: `משלוח ${s.number}` }]}
        title={`משלוח ${s.number}`}
        meta={
          <>
            <ShipmentBadge status={s.status} />
            <span>{s.customer.name}</span>
          </>
        }
      />
      <ShipmentClient s={s} perms={{ status: canUser(user, "shipment.status"), prepare: canUser(user, "shipment.prepare"), customers: canUser(user, "customer.view") }} />
    </>
  );
}
