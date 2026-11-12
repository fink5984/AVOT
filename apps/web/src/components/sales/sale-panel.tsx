import Link from "next/link";
import type { UserPrincipal } from "@/server/auth/principal";
import { canUser } from "@/server/auth/permissions";
import { saleOfItem } from "@/server/services/sales-views";
import { shipmentOfItem } from "@/server/services/shipments";
import { Panel } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { formatUsd } from "@/lib/money";
import { FinancialBadge, ShipmentBadge, StageBadge } from "./status";
import { RecordSaleButton } from "./record-sale-button";
import { LegacySaleControls } from "./legacy-sale-dialog";

/**
 * The sale of a book or lot on its own page: who bought it, for how much, the three states, the customer's other waiting
 * books, and the shipment it is in. Shows nothing for a book that was never sold and cannot be sold from here.
 */
export async function SalePanel({ user, itemId, lotId, lotNumber, commercialStatus, lotEnded }: { user: UserPrincipal; itemId: string; lotId?: string; lotNumber?: number; commercialStatus?: string; lotEnded?: boolean }) {
  if (!canUser(user, "sales.view") && !canUser(user, "shipment.prepare")) return null;
  const sale = await saleOfItem(user, itemId);
  const ship = sale ? await shipmentOfItem(user.organizationId, itemId) : null;
  const canRecord = canUser(user, "sales.correct") && lotId && !sale && (commercialStatus === "SOLD" || commercialStatus === "UNSOLD" || (commercialStatus === "ASSIGNED" && !lotEnded));
  if (!sale && !canRecord) return null;
  return (
    <Panel title="מכירה">
      <div className="space-y-2 px-4 py-3 text-[13.5px]">
        {sale && "customerId" in sale && sale.legacy && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral" dot={false}>מכירה ישנה</Badge>
            <span className="text-[12.5px] text-muted">נמכר לפני המעבר ל-AVOT</span>
          </div>
        )}
        {sale && "customerId" in sale ? (
          <>
            <div>
              קונה:{" "}
              {!sale.customerId ? (
                <span className="text-muted">לא ידוע</span>
              ) : canUser(user, "customer.view") ? (
                <Link href={`/customers/${sale.customerId}`} className="font-medium hover:underline">
                  {sale.customerName}
                </Link>
              ) : (
                <b>{sale.customerName}</b>
              )}
              {sale.customerNumber !== null && <span className="num ms-1 text-muted">#{sale.customerNumber}</span>}
            </div>
            <div className="num">
              מחיר פטיש: {sale.hammerPrice === null ? <span className="text-muted">לא ידוע</span> : <b>{formatUsd(sale.hammerPrice)}</b>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {!sale.legacy && <FinancialBadge status={sale.financial} />}
              <StageBadge stage={sale.stage} released={sale.released} />
            </div>
            {ship && (
              <div className="text-[12.5px]">
                <Link href={`/shipments/${ship.id}`} className="font-medium underline">
                  משלוח {ship.number}
                </Link>{" "}
                <ShipmentBadge status={ship.status} />
                {ship.others.length > 0 && <span className="text-muted"> · עוד {ship.others.length} ספרים באותו משלוח</span>}
              </div>
            )}
            {sale.legacy && (canUser(user, "sale.legacy") || canUser(user, "customer.edit")) && (
              <LegacySaleControls purchaseId={sale.purchaseId} canAttach={canUser(user, "sale.legacy")} canUnmark={canUser(user, "sale.legacy") && sale.stage !== "SHIPPED" && sale.stage !== "DELIVERED"} hasBuyer={!!sale.customerId} />
            )}
            {sale.otherWaitingBooks > 0 && (
              <Badge tone="warn" dot={false} className="h-auto whitespace-normal py-1 text-[12.5px]">
                שים לב: לקוח זה רכש עוד {sale.otherWaitingBooks} ספרים שעדיין לא נשלחו.{" "}
                {canUser(user, "customer.view") && (
                  <Link href={`/customers/${sale.customerId}`} className="underline">
                    כל הרכישות
                  </Link>
                )}
              </Badge>
            )}
          </>
        ) : (
          <p className="text-muted">{commercialStatus === "SOLD" ? "הלוט מסומן כנמכר, אך לא נרשם קונה." : commercialStatus === "UNSOLD" ? "הלוט לא נמכר במכרז." : "טרם נרשמה מכירה."}</p>
        )}
        {canRecord && <RecordSaleButton lotId={lotId!} lotLabel={`פריט ${lotNumber ?? ""}`} afterAuction={commercialStatus === "UNSOLD"} label={commercialStatus === "SOLD" ? "שיוך קונה" : commercialStatus === "UNSOLD" ? "רישום מכירה לאחר המכרז" : "רישום מכירה"} />}
      </div>
    </Panel>
  );
}
