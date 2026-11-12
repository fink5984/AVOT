import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { customerDetail } from "@/server/services/sales-views";
import { PageHeader } from "@/components/ui/misc";
import { CustomerClient } from "./customer-client";

export async function generateMetadata({ params }: { params: Promise<{ customerId: string }> }) {
  await params;
  return { title: "לקוח" };
}

export default async function CustomerPage({ params }: { params: Promise<{ customerId: string }> }) {
  const user = await requirePageUser("customer.view");
  const { customerId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(customerId)) notFound();
  const data = await customerDetail(user, customerId).catch(() => null);
  if (!data) notFound();
  return (
    <>
      <PageHeader breadcrumbs={[{ label: "לקוחות", href: "/customers" }, { label: data.customer.name }]} title={data.customer.name} meta={<span className="num">לקוח מספר {data.customer.number}</span>} />
      <CustomerClient
        data={data}
        perms={{
          edit: canUser(user, "customer.edit"),
          payment: canUser(user, "payment.manage"),
          release: canUser(user, "pick.release"),
          releaseUnpaid: canUser(user, "pick.release.unpaid"),
          ship: canUser(user, "shipment.prepare"),
          correct: canUser(user, "sales.correct"),
          cancel: canUser(user, "sale.cancel"),
        }}
      />
    </>
  );
}
