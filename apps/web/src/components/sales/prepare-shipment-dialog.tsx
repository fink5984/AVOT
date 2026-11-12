"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, PackageCheck } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { FinancialBadge, StageBadge, METHOD_LABEL } from "./status";

interface Book {
  purchaseId: string;
  lotId: string;
  lotNumber: number;
  catalogNumber: string;
  house: string;
  itemId: string;
  inventoryNumber: string;
  title: string;
  released: boolean;
  financial: string;
  stage: string;
  available: boolean;
  blockedReason: string | null;
  shipmentId: string | null;
}

interface PartialInfo {
  remainingLots: number;
  remainingBooks: number;
}

/**
 * "הכנה למשלוח": the customer's waiting books in one list. The lot the person came from is selected; the screen says right
 * away how many more the customer bought and offers to add every available one. Sending only part is never blocked, but asks
 * once ("אתה עומד לשלוח רק ... ללקוח יש עוד ... לוטים"), and books that cannot go (not released, in another shipment, already sent)
 * are never added by themselves.
 */
export function PrepareShipmentDialog({
  open,
  onClose,
  customerId,
  customerName,
  focusPurchaseId,
  addToShipmentId,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
  focusPurchaseId?: string;
  /** add the chosen lots to a shipment that is being prepared instead of creating one */
  addToShipmentId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState("CARRIER");
  const [partial, setPartial] = useState<PartialInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBooks(null);
    setPartial(null);
    api<{ books: Book[] }>(`/api/shipping-hint?customerId=${customerId}`)
      .then((r) => {
        setBooks(r.books);
        const focus = r.books.find((b) => b.purchaseId === focusPurchaseId && b.available);
        setPicked(new Set(focus ? [focus.purchaseId] : []));
      })
      .catch((err) => toast.error(errorMessage(err)));
  }, [open, customerId, focusPurchaseId, toast]);

  // one row per lot (a combined lot lists its books under it)
  const lots = useMemo(() => {
    const m = new Map<string, Book[]>();
    for (const b of books ?? []) m.set(b.purchaseId, [...(m.get(b.purchaseId) ?? []), b]);
    return [...m.values()];
  }, [books]);
  const availableLots = lots.filter((l) => l[0]!.available || l.every((b) => b.available));
  const others = lots.filter((l) => l[0]!.purchaseId !== focusPurchaseId);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function go(confirmPartial: boolean) {
    setBusy(true);
    try {
      if (addToShipmentId) {
        await api(`/api/shipments/${addToShipmentId}/add`, { method: "POST", json: { purchaseIds: [...picked] } });
        toast.success("הפריטים נוספו למשלוח");
        onClose();
        router.refresh();
        return;
      }
      const r = await api<{ shipment: { id: string; number: number } }>("/api/shipments", { method: "POST", json: { customerId, purchaseIds: [...picked], method, confirmPartial: confirmPartial || undefined } });
      toast.success(`נוצר משלוח ${r.shipment.number}`, { detail: "הספרים שמורים למשלוח. הם יסומנו כנשלחו רק כשיצאו פיזית" });
      onClose();
      router.push(`/shipments/${r.shipment.id}`);
    } catch (err) {
      if (err instanceof ApiError && (err.details as { code?: string } | undefined)?.code === "PARTIAL_SHIPMENT") setPartial(err.details as PartialInfo);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={addToShipmentId ? "הוספה למשלוח" : `הכנה למשלוח · ${customerName}`}
      footer={
        partial ? undefined : (
          <>
            <Button onClick={onClose}>ביטול</Button>
            <Button variant="primary" icon={<PackageCheck />} loading={busy} disabled={picked.size === 0} onClick={() => go(false)}>
              {addToShipmentId ? "הוספה" : `יצירת משלוח (${picked.size} לוטים)`}
            </Button>
          </>
        )
      }
    >
      {books === null ? (
        <p className="py-6 text-center text-muted">טוען…</p>
      ) : partial ? (
        <div role="alert" className="space-y-4">
          <div className="flex gap-2 rounded-lg bg-warn-soft px-4 py-3 text-[14px] leading-relaxed text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              אתה עומד לשלוח רק {picked.size} {picked.size === 1 ? "לוט" : "לוטים"}, אבל ללקוח יש עוד <b className="num">{partial.remainingLots}</b> לוטים שעדיין לא נשלחו.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setPartial(null)}>
              חזרה ובחירת פריטים נוספים
            </Button>
            <Link href={`/customers/${customerId}`} className="inline-flex h-9 items-center rounded-md border border-rule-strong px-3.5 text-[13.5px] font-medium hover:bg-stone-2">
              צפייה ברשימת הרכישות
            </Link>
            <Button loading={busy} onClick={() => go(true)}>
              המשך משלוח חלקי
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {focusPurchaseId && others.length > 0 && (
            <div className="rounded-lg bg-accent-soft px-4 py-3 text-[13.5px]" data-testid="more-purchases">
              <p className="font-medium">שים לב: לקוח זה רכש עוד {others.length} לוטים.</p>
              <p className="mt-0.5 text-ink-2">
                {availableLots.length - (availableLots.some((l) => l[0]!.purchaseId === focusPurchaseId) ? 1 : 0)} מהם זמינים למשלוח עכשיו.{" "}
                <Link href={`/customers/${customerId}`} className="underline">
                  כל הרכישות של הלקוח
                </Link>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setPicked(new Set(availableLots.map((l) => l[0]!.purchaseId)))}>
                  צרף את כל הפריטים הזמינים
                </Button>
                <Button size="sm" onClick={() => setPicked(new Set(focusPurchaseId ? [focusPurchaseId] : []))}>
                  המשך עם הפריט הזה בלבד
                </Button>
              </div>
            </div>
          )}
          {lots.length === 0 && <p className="py-4 text-center text-muted">אין ללקוח ספרים שממתינים למשלוח.</p>}
          <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-rule">
            {lots.map((l) => {
              const first = l[0]!;
              const ok = l.every((b) => b.available);
              return (
                <li key={first.purchaseId} className={cn("flex items-start gap-3 px-3.5 py-2.5 text-[13.5px]", !ok && "bg-stone-2/60 text-muted")}>
                  <input type="checkbox" disabled={!ok} checked={picked.has(first.purchaseId)} onChange={() => toggle(first.purchaseId)} aria-label={`בחירת פריט ${first.lotNumber}`} className="mt-1 size-4 accent-[var(--color-ink)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="num font-semibold">{first.lotNumber}</span>
                      <span className="truncate font-medium">{l.map((b) => b.title).join(" · ")}</span>
                    </div>
                    <div className="num text-[12px] text-muted">
                      {first.house}, קטלוג {first.catalogNumber}
                      {l.length > 1 ? ` · ${l.length} ספרים` : ""}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StageBadge stage={first.stage} released={first.released} />
                      <FinancialBadge status={first.financial} />
                      {first.blockedReason && <span className="text-[12px] text-warn">{first.blockedReason}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {!addToShipmentId && (
            <label className="flex items-center gap-2 text-[13.5px]">
              שיטת מסירה
              <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-48" aria-label="שיטת מסירה">
                {Object.entries(METHOD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
    </Dialog>
  );
}
