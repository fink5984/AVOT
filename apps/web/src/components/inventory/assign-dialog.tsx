"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

interface House {
  id: string;
  slug: string;
  name: string;
  accentColor: string;
}
interface CatalogOption {
  id: string;
  number: string;
  name: string;
  status: string;
}
interface ActiveLot {
  id: string;
  lotNumber: number;
  catalogNumber: string;
  house: string;
}

/**
 * "שייך לקטלוג": house → catalog → lot number (or next free) → optional
 * catalog-specific description. The book itself is never duplicated. When it
 * already has an active assignment the server refuses (409) and the dialog
 * offers to end it first — the old assignment is kept as history.
 */
export function AssignDialog({
  open,
  onClose,
  items,
  defaultHouse,
}: {
  open: boolean;
  onClose: () => void;
  /** one book → full form; several → house + catalog only (next free numbers) */
  items: { id: string; inventoryNumber: string; title: string }[];
  defaultHouse?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [houses, setHouses] = useState<House[]>([]);
  const [house, setHouse] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogOption[]>([]);
  const [catalogId, setCatalogId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveLot | null>(null);
  const [endOutcome, setEndOutcome] = useState<"UNSOLD" | "WITHDRAWN">("UNSOLD");
  const [replaceAll, setReplaceAll] = useState(false);
  const single = items.length === 1;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setActive(null);
    api<{ houses: House[] }>("/api/houses")
      .then((r) => {
        setHouses(r.houses);
        setHouse((h) => h ?? r.houses.find((x) => x.slug === defaultHouse)?.id ?? r.houses[0]?.id ?? null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [open, defaultHouse]);

  useEffect(() => {
    if (!open || !house) return;
    api<{ catalogs: CatalogOption[] }>(`/api/catalogs?houseId=${house}`)
      .then((r) => {
        const usable = r.catalogs.filter((c) => c.status !== "ARCHIVED");
        setCatalogs(usable);
        setCatalogId(usable[0]?.id ?? "");
      })
      .catch((e) => setError(errorMessage(e)));
  }, [open, house]);

  async function submit(e: React.FormEvent<HTMLFormElement>, replaceActive = false) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim() || null;
    setBusy(true);
    setError(null);
    try {
      if (single) {
        const num = str("lotNumber");
        const r = await api<{ lot: { id: string; lotNumber: number } }>(`/api/inventory/${items[0]!.id}/assign`, {
          method: "POST",
          json: {
            catalogId,
            ...(num ? { lotNumber: Number(num) } : {}),
            title: str("title"),
            shortDescription: str("shortDescription"),
            description: str("description"),
            ...(replaceActive ? { replaceActive: true, endOutcome } : {}),
          },
        });
        toast.success(`שויך כפריט ${r.lot.lotNumber}`, { detail: "התמונות הקיימות של הספר זמינות בקטלוג." });
      } else {
        const r = await api<{ done: { itemId: string; lotNumber: number }[]; failed: { itemId: string; message: string }[] }>("/api/inventory/bulk-assign", {
          method: "POST",
          json: { itemIds: items.map((i) => i.id), catalogId, replaceActive: replaceActive || replaceAll },
        });
        if (r.failed.length) toast.warning(`${r.done.length} שויכו · ${r.failed.length} לא שויכו`, { detail: r.failed.slice(0, 3).map((x) => x.message).join(" · ") });
        else toast.success(`${r.done.length} ספרים שויכו לקטלוג`);
      }
      onClose();
      router.refresh();
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { activeLot?: ActiveLot } | undefined) : undefined;
      if (details?.activeLot) setActive(details.activeLot);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const currentHouse = houses.find((h) => h.id === house);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={single ? `שיוך לקטלוג · ${items[0]?.inventoryNumber ?? ""}` : `שיוך ${items.length} ספרים לקטלוג`}
      description={single ? items[0]?.title : "הספרים יקבלו את מספרי הפריט הפנויים הבאים, לפי הסדר שנבחר."}
      width="md"
    >
      <form id="assign-form" onSubmit={(e) => submit(e)} className="space-y-4">
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">בית מכירות</div>
          <div role="radiogroup" aria-label="בית מכירות" className="inline-flex gap-0.5 rounded-lg bg-stone p-0.5">
            {houses.map((h) => (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={house === h.id}
                onClick={() => setHouse(h.id)}
                className={cn("flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[13.5px] font-medium", house === h.id ? "bg-paper shadow-card ring-1 ring-rule" : "text-ink-2")}
              >
                <span className="size-2 rounded-[2px]" style={{ background: h.accentColor }} aria-hidden />
                {h.name}
              </button>
            ))}
          </div>
        </div>
        <Field label="קטלוג" required>
          {(p) => (
            <Select {...p} value={catalogId} onChange={(e) => setCatalogId(e.target.value)} required>
              {catalogs.length === 0 && <option value="">אין קטלוגים פתוחים ב{currentHouse?.name ?? "בית המכירות"}</option>}
              {catalogs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.number} · {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {single && (
          <>
            <Field label="מספר פריט" hint="ריק = המספר הפנוי הבא בקטלוג">
              {(p) => <Input {...p} name="lotNumber" type="number" min={1} max={99999} inputMode="numeric" className="num w-32" />}
            </Field>
            <Field label="כותרת לקטלוג" hint="ריק = שם הספר מהמלאי">
              {(p) => <Input {...p} name="title" maxLength={300} placeholder={items[0]?.title} />}
            </Field>
            <Field label="תיאור קצר לקטלוג זה">
              {(p) => <Textarea {...p} name="shortDescription" rows={2} maxLength={2000} />}
            </Field>
            <Field label="תיאור מלא לקטלוג זה">
              {(p) => <Textarea {...p} name="description" rows={3} maxLength={20000} />}
            </Field>
          </>
        )}
        {!single && (
          <Checkbox
            label="ספרים שכבר משויכים לקטלוג פעיל: לסיים את השיוך הקודם (״הוסר ממכירה״) ולשייך מחדש"
            checked={replaceAll}
            onChange={(e) => setReplaceAll(e.currentTarget.checked)}
          />
        )}
        {error && (
          <div className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
            {active && (
              <div className="mt-3 border-t border-danger/20 pt-3 text-ink-2">
                <p>אפשר לסיים את השיוך הפעיל ולפתוח שיוך חדש. השיוך הקודם יישמר בהיסטוריה.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select value={endOutcome} onChange={(e) => setEndOutcome(e.target.value as "UNSOLD" | "WITHDRAWN")} className="h-8 w-auto" aria-label="סיום השיוך הקודם כ…">
                    <option value="UNSOLD">השיוך הקודם: לא נמכר</option>
                    <option value="WITHDRAWN">השיוך הקודם: הוסר ממכירה</option>
                  </Select>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy}
                    onClick={() => {
                      const form = document.getElementById("assign-form") as HTMLFormElement;
                      void submit({ preventDefault() {}, currentTarget: form } as unknown as React.FormEvent<HTMLFormElement>, true);
                    }}
                  >
                    סיום השיוך הקודם ושיוך מחדש
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </form>
      <div className="mt-5 flex gap-2">
        <Button type="submit" form="assign-form" variant="primary" loading={busy} disabled={!catalogId}>
          שיוך
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
