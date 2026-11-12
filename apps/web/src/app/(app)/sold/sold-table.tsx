"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PackageCheck, Send } from "lucide-react";
import type { SoldRow } from "@/server/services/sales-views";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { FinancialBadge, StageBadge } from "@/components/sales/status";
import { PrepareShipmentDialog } from "@/components/sales/prepare-shipment-dialog";
import { api, errorMessage } from "@/lib/api";
import { formatUsd } from "@/lib/money";
import { fmt } from "@/i18n";
import { AttachBuyerDialog } from "@/components/sales/legacy-sale-dialog";

const itemHref = (r: SoldRow) => (r.lotId ? `/lots/${r.lotId}` : `/inventory/${r.itemId}`);

const STAGES = [
  ["AWAITING_RELEASE", "ממתין לשחרור לליקוט"],
  ["AWAITING_PICK", "ממתין לליקוט"],
  ["PICKED", "לוקט"],
  ["PACKED", "נארז"],
  ["SHIPPED", "נשלח"],
  ["DELIVERED", "נמסר"],
] as const;

export function SoldTable({
  rows,
  truncated,
  catalogs,
  houses,
  filters,
  perms,
}: {
  rows: SoldRow[];
  truncated: boolean;
  catalogs: { id: string; label: string }[];
  houses: { id: string; name: string }[];
  filters: { q: string; catalogId: string; houseId: string; financial: string; stage: string };
  perms: { release: boolean; releaseUnpaid: boolean; ship: boolean; customers: boolean; legacy: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [prep, setPrep] = useState<SoldRow | null>(null);
  const [attach, setAttach] = useState<SoldRow | null>(null);

  async function release(r: SoldRow) {
    // a sale from the old system was settled before AVOT: there is no payment state to wait for
    if (!r.legacy && r.financial !== "PAID" && !perms.releaseUnpaid) return toast.error("הרכישה טרם שולמה במלואה. שחרור לפני תשלום דורש הרשאה מיוחדת");
    if (!r.legacy && r.financial !== "PAID" && !window.confirm(`פריט ${r.lotNumber} טרם שולם במלואו. לשחרר אותו לליקוט בכל זאת?`)) return;
    try {
      await api(`/api/purchases/${r.purchaseId}/release`, { method: "POST" });
      toast.success(r.legacy ? "הספר שוחרר לליקוט" : `פריט ${r.lotNumber} שוחרר לליקוט`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <form action="/sold" className="mb-4 flex flex-wrap items-center gap-2">
        <Input type="search" name="q" defaultValue={filters.q} placeholder="חיפוש: שם ספר, מספר לוט, מספר מלאי, לקוח, קטלוג" aria-label="חיפוש" className="min-w-0 flex-1 sm:w-80 sm:flex-none" />
        <Select name="houseId" defaultValue={filters.houseId} aria-label="בית מכירות" className="w-full sm:w-40">
          <option value="">כל בתי המכירות</option>
          {houses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
        <Select name="catalogId" defaultValue={filters.catalogId} aria-label="קטלוג" className="w-full sm:w-56">
          <option value="">כל הקטלוגים</option>
          {catalogs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select name="financial" defaultValue={filters.financial} aria-label="מצב תשלום" className="w-full sm:w-40">
          <option value="">כל מצבי התשלום</option>
          <option value="UNPAID">ממתין לתשלום</option>
          <option value="PARTIAL">שולם חלקית</option>
          <option value="PAID">שולם</option>
        </Select>
        <Select name="stage" defaultValue={filters.stage} aria-label="מצב ליקוט ומשלוח" className="w-full sm:w-48">
          <option value="">כל מצבי הליקוט והמשלוח</option>
          <option value="OPEN">בטיפול (טרם נשלח)</option>
          <option value="DONE">הטיפול הסתיים (נשלח / נמסר)</option>
          <option value="READY">מוכן למשלוח (משוחרר, טרם במשלוח)</option>
          {STAGES.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary">
          סינון
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="אין לוטים שנמכרו">לוטים יופיעו כאן אחרי ייבוא תוצאות מכירה (מדף הקטלוג) או רישום מכירה ידני.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-rule bg-paper shadow-card">
          {/* phones: a card per lot */}
          <ul className="divide-y divide-rule md:hidden">
            {rows.map((r) => (
              <li key={r.purchaseId} className="flex gap-3 px-3 py-3">
                <span className="block size-16 shrink-0 overflow-hidden rounded-md bg-stone ring-1 ring-rule">{r.thumbAssetId && <img src={`/api/assets/${r.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
                <div className="min-w-0 flex-1 text-[13px]">
                  <Link href={itemHref(r)} className="block text-[14.5px] font-medium leading-snug">
                    {r.lotNumber !== null && <span className="num me-1.5 rounded bg-stone px-1.5 text-[13px] font-semibold">{r.lotNumber}</span>}
                    {r.title}
                  </Link>
                  <div className="mt-0.5 text-muted">{r.legacy ? `מכירה ישנה · ${r.inventoryNumber ?? ""}` : `${r.house}, קטלוג ${r.catalogNumber}`}</div>
                  {r.location && <div className="text-[12px] text-muted">{r.location}</div>}
                  <div className="mt-0.5">
                    {r.customerId ? perms.customers ? <Link href={`/customers/${r.customerId}`} className="font-medium text-ink-2 underline-offset-2 hover:underline">{r.customerName}</Link> : r.customerName : <span className="text-muted">לקוח לא ידוע</span>} · {r.hammerPrice === null ? <span className="text-muted">מחיר לא ידוע</span> : <span className="num font-semibold">{formatUsd(r.hammerPrice)}</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {r.legacy && <Badge tone="neutral" dot={false}>מכירה ישנה</Badge>}
                    {!r.legacy && <FinancialBadge status={r.financial} />}
                    <StageBadge stage={r.stage} released={r.released} />
                  </div>
                  <RowActions r={r} perms={perms} onRelease={release} onPrepare={setPrep} onAttach={setAttach} />
                </div>
              </li>
            ))}
          </ul>
          <table className="hidden w-full text-[13.5px] md:table">
            <thead>
              <tr className="border-b border-rule bg-stone-2/60 text-[12.5px] text-muted">
                <th className="w-24 px-3 py-3 text-start font-medium">לוט</th>
                <th className="px-3 py-3 text-start font-medium">ספר</th>
                <th className="px-3 py-3 text-start font-medium">קטלוג</th>
                <th className="px-3 py-3 text-start font-medium">קונה</th>
                <th className="px-3 py-3 text-start font-medium">פתיחה / מכירה</th>
                <th className="px-3 py-3 text-start font-medium">תשלום</th>
                <th className="px-3 py-3 text-start font-medium">ליקוט ומשלוח</th>
                <th className="w-40 px-3 py-3" aria-label="פעולות" />
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {rows.map((r) => (
                <tr key={r.purchaseId} className="align-top hover:bg-stone-2/40">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="block size-10 shrink-0 overflow-hidden rounded bg-stone ring-1 ring-rule">{r.thumbAssetId && <img src={`/api/assets/${r.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
                      <Link href={itemHref(r)} className="num font-semibold underline-offset-2 hover:underline">
                        {r.lotNumber ?? "פתיחה"}
                      </Link>
                    </div>
                  </td>
                  <td className="max-w-72 px-3 py-3">
                    <div className="font-medium leading-snug">{r.title}</div>
                    <div className="num font-mono text-[11.5px] text-muted">{r.books.length > 1 ? `${r.books.length} ספרים · ` : ""}{r.books.map((b) => b.inventoryNumber).join(" · ")}</div>
                    {r.location && <div className="text-[12px] text-muted">{r.location}</div>}
                    {r.afterAuction && <Badge tone="info" className="mt-1">נמכר לאחר המכרז</Badge>}
                    {r.legacy && <Badge tone="neutral" dot={false} className="mt-1">מכירה ישנה</Badge>}
                  </td>
                  <td className="px-3 py-3 text-[12.5px]">
                    {r.catalogId ? (
                      <>
                        <Link href={`/catalogs/${r.catalogId}`} className="hover:underline">
                          {r.house}, {r.catalogNumber}
                        </Link>
                        <div className="text-muted">{fmt.date(r.saleDate)}</div>
                      </>
                    ) : (
                      <span className="text-muted">ללא קטלוג</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {r.customerId ? (
                      <>
                        {perms.customers ? <Link href={`/customers/${r.customerId}`} className="font-medium hover:underline">{r.customerName}</Link> : r.customerName}
                        <div className="num text-[11.5px] text-muted">לקוח {r.customerNumber}</div>
                      </>
                    ) : (
                      <span className="text-muted">לא ידוע</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="num text-muted">{formatUsd(r.startingPrice, "פתיחה: לא הוגדר")}</div>
                    {r.hammerPrice === null ? <div className="text-[13px] text-muted">מחיר לא ידוע</div> : <div className="num text-[15px] font-semibold">{formatUsd(r.hammerPrice)}</div>}
                  </td>
                  <td className="px-3 py-3">{r.legacy ? <span className="text-[12px] text-muted">אין נתוני תשלום</span> : <FinancialBadge status={r.financial} />}</td>
                  <td className="px-3 py-3">
                    <StageBadge stage={r.stage} released={r.released} />
                    {r.releasedUnpaid && <div className="mt-0.5 text-[11.5px] text-warn">שוחרר לפני תשלום</div>}
                    {r.shipmentNumber && (
                      <Link href={`/shipments/${r.shipmentId}`} className="mt-0.5 block text-[12px] text-ink-2 hover:underline">
                        משלוח {r.shipmentNumber}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <RowActions r={r} perms={perms} onRelease={release} onPrepare={setPrep} onAttach={setAttach} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <p className="mt-3 text-[12.5px] text-muted">מוצגות 1,000 השורות הראשונות. יש לצמצם את הסינון.</p>}
      {prep && prep.customerId && <PrepareShipmentDialog open onClose={() => setPrep(null)} customerId={prep.customerId} customerName={prep.customerName ?? ""} focusPurchaseId={prep.purchaseId} />}
      {attach && <AttachBuyerDialog open onClose={() => setAttach(null)} purchaseId={attach.purchaseId} />}
    </>
  );
}

function RowActions({ r, perms, onRelease, onPrepare, onAttach }: { r: SoldRow; perms: { release: boolean; ship: boolean; legacy?: boolean }; onRelease: (r: SoldRow) => void; onPrepare: (r: SoldRow) => void; onAttach: (r: SoldRow) => void }) {
  const gone = r.stage === "SHIPPED" || r.stage === "DELIVERED";
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 md:mt-0">
      {perms.release && !r.released && !gone && (
        <Button size="sm" icon={<Send />} onClick={() => onRelease(r)}>
          שחרור לליקוט
        </Button>
      )}
      {r.legacy && !r.customerId && perms.legacy && !gone && (
        <Button size="sm" onClick={() => onAttach(r)}>
          שיוך לקוח
        </Button>
      )}
      {perms.ship && !gone && !r.shipmentId && r.customerId && (
        <Button size="sm" variant="primary" icon={<PackageCheck />} onClick={() => onPrepare(r)}>
          הכנה למשלוח
        </Button>
      )}
    </div>
  );
}
