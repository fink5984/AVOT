"use client";

import { useState } from "react";
import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListControls, ListResults, type FilterGroup } from "@/components/list/list-controls";
import { EmptyState, Panel } from "@/components/ui/misc";
import { FinancialBadge, ShipmentBadge } from "@/components/sales/status";
import { PrepareShipmentDialog } from "@/components/sales/prepare-shipment-dialog";

interface Row {
  customerId: string;
  number: number;
  name: string;
  waitingLots: number;
  waitingBooks: number;
  readyBooks: number;
  shippedLots: number;
  financial: string;
  catalogs: string[];
  openShipments: number;
}

export function ShipmentsClient({
  rows,
  open,
  catalogs,
  houses,
  canCustomers,
  canMoney = true,
}: {
  rows: Row[];
  open: { id: string; number: number; status: string; customer: string; lots: number; books: number }[];
  catalogs: { id: string; label: string }[];
  houses: { id: string; name: string }[];
  canCustomers: boolean;
  /** payment states are hidden from warehouse staff (they do not see money) */
  canMoney?: boolean;
}) {
  const [prep, setPrep] = useState<Row | null>(null);
  const groups: FilterGroup[] = [
    { kind: "multi", key: "houseId", label: "בית מכירות", section: "קטלוגים ומכירות", options: houses.map((h) => ({ value: h.id, label: h.name })) },
    { kind: "multi", key: "catalogId", label: "קטלוג", section: "קטלוגים ומכירות", searchable: true, options: catalogs.map((c) => ({ value: c.id, label: c.label })) },
    ...(canMoney
      ? ([
          {
            kind: "multi",
            key: "financial",
            label: "מצב כספי",
            section: "תשלום",
            options: [
              { value: "UNPAID", label: "ממתין לתשלום" },
              { value: "PARTIAL", label: "שולם חלקית" },
              { value: "PAID", label: "שולם" },
            ],
          },
        ] satisfies FilterGroup[])
      : []),
    {
      kind: "multi",
      key: "stage",
      label: "מצב ליקוט",
      section: "ליקוט ומשלוח",
      options: [
        { value: "AWAITING_PICK", label: "ממתין לליקוט" },
        { value: "PICKED", label: "לוקט" },
        { value: "PACKED", label: "נארז" },
      ],
    },
    { kind: "flag", key: "ready", label: "מוכנים למשלוח", section: "ליקוט ומשלוח" },
    { kind: "flag", key: "partial", label: "משלוחים חלקיים", section: "ליקוט ומשלוח" },
  ];
  return (
    <>
      {open.length > 0 && (
        <Panel title="משלוחים בהכנה" className="mb-5">
          <ul className="divide-y divide-rule">
            {open.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13.5px]">
                <Link href={`/shipments/${s.id}`} className="font-medium hover:underline">
                  משלוח {s.number} · {s.customer}
                </Link>
                <span className="num text-muted">
                  {s.lots} לוטים · {s.books} ספרים
                </span>
                <ShipmentBadge status={s.status} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <ListControls className="mb-4" placeholder="חיפוש לקוח: שם, אימייל או טלפון" searchLabel="חיפוש לקוח" groups={groups} />
      <ListResults>

      {rows.length === 0 ? (
        <EmptyState title="אין לקוחות עם פריטים שממתינים למשלוח" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-paper shadow-card">
          <ul className="divide-y divide-rule">
            {rows.map((r) => (
              <li key={r.customerId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[13.5px]">
                <div className="min-w-48 flex-1">
                  {canCustomers ? (
                    <Link href={`/customers/${r.customerId}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.name}</span>
                  )}
                  <span className="num ms-2 text-[12px] text-muted">#{r.number}</span>
                  <div className="text-[12px] text-muted">{r.catalogs.join(" · ")}</div>
                </div>
                <div className="num text-[12.5px]">
                  <div>
                    <b>{r.waitingLots}</b> לוטים ממתינים · <b>{r.waitingBooks}</b> ספרים
                  </div>
                  <div className="text-muted">
                    {r.readyBooks} מוכנים · {r.shippedLots} לוטים נשלחו
                  </div>
                </div>
                <FinancialBadge status={r.financial} />
                {r.openShipments > 0 && <span className="text-[12.5px] text-info">יש משלוח פתוח</span>}
                <Button size="sm" variant="primary" icon={<PackageCheck />} onClick={() => setPrep(r)}>
                  הכנת משלוח
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      </ListResults>
      {prep && <PrepareShipmentDialog open onClose={() => setPrep(null)} customerId={prep.customerId} customerName={prep.name} />}
    </>
  );
}
