"use client";

import { useState } from "react";
import Link from "next/link";
import { PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
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
  filters,
  canCustomers,
}: {
  rows: Row[];
  open: { id: string; number: number; status: string; customer: string; lots: number; books: number }[];
  catalogs: { id: string; label: string }[];
  houses: { id: string; name: string }[];
  filters: { q: string; houseId: string; catalogId: string; financial: string; stage: string; partial: boolean; ready: boolean };
  canCustomers: boolean;
}) {
  const [prep, setPrep] = useState<Row | null>(null);
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

      <form action="/shipments" className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="search" name="q" defaultValue={filters.q} placeholder="חיפוש לקוח" aria-label="חיפוש לקוח" className="min-w-0 flex-1 sm:w-56 sm:flex-none" />
        <Select name="houseId" defaultValue={filters.houseId} aria-label="בית מכירות" className="w-full sm:w-40">
          <option value="">כל בתי המכירות</option>
          {houses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
        <Select name="catalogId" defaultValue={filters.catalogId} aria-label="קטלוג" className="w-full sm:w-52">
          <option value="">כל הקטלוגים</option>
          {catalogs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select name="financial" defaultValue={filters.financial} aria-label="מצב כספי" className="w-full sm:w-40">
          <option value="">כל המצבים הכספיים</option>
          <option value="UNPAID">ממתין לתשלום</option>
          <option value="PARTIAL">שולם חלקית</option>
          <option value="PAID">שולם</option>
        </Select>
        <Select name="stage" defaultValue={filters.stage} aria-label="מצב ליקוט" className="w-full sm:w-40">
          <option value="">כל מצבי הליקוט</option>
          <option value="AWAITING_PICK">ממתין לליקוט</option>
          <option value="PICKED">לוקט</option>
          <option value="PACKED">נארז</option>
        </Select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" name="ready" value="1" defaultChecked={filters.ready} className="size-4 accent-[var(--color-ink)]" />
          מוכנים למשלוח
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" name="partial" value="1" defaultChecked={filters.partial} className="size-4 accent-[var(--color-ink)]" />
          משלוחים חלקיים
        </label>
        <Button type="submit" variant="primary">
          סינון
        </Button>
      </form>

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
      {prep && <PrepareShipmentDialog open onClose={() => setPrep(null)} customerId={prep.customerId} customerName={prep.name} />}
    </>
  );
}
