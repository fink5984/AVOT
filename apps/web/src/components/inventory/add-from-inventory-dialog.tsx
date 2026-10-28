"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

interface Row {
  id: string;
  inventoryNumber: string;
  barcode: string;
  title: string;
  author: string | null;
  physicalStatus: string;
  commercialStatus: string;
  thumbAssetId: string | null;
  assignment: { lotNumber: number; catalog: { number: string }; house: { name: string } } | { hidden: true } | null;
}

/**
 * "הוסף ספרים מהמלאי": search the shared inventory by name, inventory number or barcode, tick any number
 * of books and add them in one action. The books are not copied. A book that already sits in another active
 * catalog is shown as such and is only moved when its own "העבר לכאן" box is ticked.
 */
export function AddFromInventoryDialog({ open, onClose, catalogId, catalogLabel }: { open: boolean; onClose: () => void; catalogId: string; catalogLabel: string }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, Row>>(new Map());
  const [move, setMove] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ itemId: string; message: string }[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setPicked(new Map());
    setMove(new Set());
    setFailed([]);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api<{ items: Row[] }>(`/api/inventory?pageSize=40&sort=updated&notInCatalogId=${catalogId}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
        if (n === seq.current) setRows(r.items);
      } catch (err) {
        if (n === seq.current) toast.error(errorMessage(err));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [open, q, catalogId]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = (r: Row) => r.commercialStatus === "SOLD" || r.physicalStatus === "SHIPPED" || r.commercialStatus === "OFFERED";
  const elsewhere = (r: Row) => r.assignment !== null;

  const toggle = (r: Row) =>
    setPicked((p) => {
      const n = new Map(p);
      if (n.has(r.id)) n.delete(r.id);
      else n.set(r.id, r);
      return n;
    });

  async function submit() {
    setBusy(true);
    setFailed([]);
    try {
      const ids = [...picked.keys()];
      const r = await api<{ done: unknown[]; failed: { itemId: string; message: string }[] }>("/api/inventory/bulk-assign", {
        method: "POST",
        json: { itemIds: ids, catalogId, replaceItemIds: ids.filter((id) => move.has(id)) },
      });
      if (r.failed.length) {
        setFailed(r.failed);
        toast.warning(`${r.done.length} נוספו · ${r.failed.length} לא נוספו`);
        setPicked((p) => new Map([...p].filter(([id]) => r.failed.some((f) => f.itemId === id))));
      } else {
        toast.success(`${r.done.length} ספרים נוספו לקטלוג`);
        onClose();
      }
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="הוספת ספרים מהמלאי" description={`לקטלוג ${catalogLabel}. הספרים לא משוכפלים — הם מקבלים מספר פריט בקטלוג.`} width="lg">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="שם ספר, מספר ספר או ברקוד" className="ps-9" aria-label="חיפוש במלאי" />
      </div>
      <ul className={cn("mt-3 max-h-[46vh] divide-y divide-rule overflow-y-auto rounded-md border border-rule", loading && "opacity-60")}>
        {rows.length === 0 && <li className="px-4 py-8 text-center text-[13px] text-muted">{loading ? "מחפש…" : "לא נמצאו ספרים"}</li>}
        {rows.map((r) => {
          const on = picked.has(r.id);
          const hiddenOther = r.assignment && "hidden" in r.assignment;
          return (
            <li key={r.id} className={cn("flex items-center gap-3 px-3 py-2", on && "bg-accent-soft/40", blocked(r) && "opacity-55")}>
              <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={on} disabled={blocked(r) || !!hiddenOther} onChange={() => toggle(r)} aria-label={`בחירת ${r.inventoryNumber}`} />
              <span className="block size-9 shrink-0 overflow-hidden rounded bg-stone ring-1 ring-rule">{r.thumbAssetId && <img src={`/api/assets/${r.thumbAssetId}/thumb`} alt="" loading="lazy" className="size-full object-cover" />}</span>
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => !blocked(r) && !hiddenOther && toggle(r)}>
                <span className="block truncate text-[13.5px] font-medium">{r.title}</span>
                <span className="block truncate text-[12px] text-muted">
                  <span className="num font-mono">{r.inventoryNumber}</span>
                  {r.author && <> · {r.author}</>}
                </span>
              </button>
              <div className="shrink-0 text-end text-[12px]">
                {blocked(r) ? (
                  <span className="text-muted">{r.commercialStatus === "OFFERED" ? "מוצע כעת למכירה" : "נמכר"}</span>
                ) : hiddenOther ? (
                  <span className="text-muted">משויך לבית מכירות אחר</span>
                ) : elsewhere(r) ? (
                  <label className={cn("flex cursor-pointer items-center gap-1.5", on ? "text-warn" : "text-muted")}>
                    <span>
                      משויך: {(r.assignment as { house: { name: string }; catalog: { number: string }; lotNumber: number }).house.name} · קטלוג <span className="num">{(r.assignment as { catalog: { number: string } }).catalog.number}</span>
                    </span>
                    {on && (
                      <span className="flex items-center gap-1 font-medium">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-[var(--color-accent)]"
                          checked={move.has(r.id)}
                          onChange={() =>
                            setMove((m) => {
                              const n = new Set(m);
                              if (n.has(r.id)) n.delete(r.id);
                              else n.add(r.id);
                              return n;
                            })
                          }
                        />
                        העבר לכאן
                      </span>
                    )}
                  </label>
                ) : (
                  <span className="text-faint">לא משויך</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {failed.length > 0 && (
        <ul className="mt-3 space-y-0.5 rounded-md bg-danger-soft px-3 py-2 text-[12.5px] text-danger" role="alert">
          {failed.slice(0, 5).map((f) => (
            <li key={f.itemId}>{f.message}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" loading={busy} disabled={picked.size === 0} onClick={submit}>
          הוספת {picked.size || ""} {picked.size === 1 ? "ספר" : "ספרים"}
        </Button>
        <Button onClick={onClose}>סגירה</Button>
        {[...picked.keys()].some((id) => elsewhere(picked.get(id)!) && !move.has(id)) && <span className="text-[12.5px] text-warn">ספרים שמשויכים לקטלוג אחר יידלגו אלא אם סימנתם ״העבר לכאן״.</span>}
      </div>
    </Dialog>
  );
}
