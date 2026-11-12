"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatUsd, parseUsd } from "@/lib/money";
import type { LotRow } from "./lots-table";

/** Same text as the server (DIFFERENT_CONSIGNORS_MESSAGE): the server repeats every check, this only tells the user earlier. */
const DIFFERENT_CONSIGNORS = "לא ניתן לאחד ספרים ממפקידים שונים. כל הספרים בלוט משולב חייבים להשתייך לאותו מפקיד.";

/**
 * "איחוד ללוט": lists the selected lots, checks what can be known in the browser (one consignor, nothing sold or
 * already combined), lets the user choose which lot number survives and an optional shared title, then asks the server,
 * which checks everything again inside a transaction.
 */
export function MergeLotsDialog({ open, onClose, catalogId, lots, onDone }: { open: boolean; onClose: () => void; catalogId: string; lots: LotRow[]; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const sorted = useMemo(() => [...lots].sort((a, b) => a.lotNumber - b.lotNumber), [lots]);
  const [keep, setKeep] = useState<string>("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  /** the combined lot is one sale unit: its starting price is set by the person, never added up from the books */
  const [price, setPrice] = useState("");
  const [priceMode, setPriceMode] = useState<"new" | "keep">("new");
  const anyPrice = sorted.some((l) => l.startingPrice);

  useEffect(() => {
    if (open) {
      setKeep(sorted[0]?.id ?? "");
      setTitle("");
      setPrice("");
      setPriceMode("new");
    }
  }, [open, sorted]);

  const problems = useMemo(() => {
    const out: string[] = [];
    if (sorted.length < 2) out.push("יש לבחור לפחות שני פריטים");
    const consignors = new Set(sorted.map((l) => l.consignorId ?? "none"));
    if (sorted.some((l) => !l.consignorId)) out.push("לאחד הספרים אין מפקיד מוגדר. כל הספרים בלוט משולב חייבים מפקיד מוגדר.");
    else if (consignors.size > 1) out.push(DIFFERENT_CONSIGNORS);
    for (const l of sorted) {
      if (l.bookCount > 1) out.push(`פריט ${l.lotNumber} כבר משולב מכמה ספרים. להוספת ספרים ללוט משולב יש להשתמש ב״הוסף ספר ללוט״ בדף הלוט.`);
      if (l.assignmentStatus !== "ACTIVE") out.push(`השיוך של פריט ${l.lotNumber} הסתיים`);
      if (l.commercialStatus !== "ASSIGNED") out.push(`פריט ${l.lotNumber} כבר הוצע / נמכר - לא ניתן לשנות את הרכבו`);
    }
    return [...new Set(out)];
  }, [sorted]);

  async function run() {
    let priceJson: { startingPrice?: string | null; keepPrice?: boolean } = {};
    try {
      if (anyPrice) priceJson = priceMode === "keep" ? { keepPrice: true } : { startingPrice: parseUsd(price) };
    } catch (e) {
      toast.error((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ lotNumber: number; itemIds: string[]; absorbed: number[] }>(`/api/catalogs/${catalogId}/lots/merge`, {
        method: "POST",
        json: { lotIds: sorted.map((l) => l.id), keepLotId: keep, title: title.trim() || undefined, ...priceJson },
      });
      toast.success(`נוצר לוט משולב: פריט ${r.lotNumber} · ${r.itemIds.length} ספרים`, {
        detail: `המספרים בקטלוג הסתדרו מחדש ברצף. הפריטים שאוחדו נשמרו בהיסטוריה.`,
      });
      onDone();
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="איחוד ללוט"
      description="הספרים שנבחרו יימכרו כלוט אחד: מספר פריט אחד, מחיר אחד ותוצאה אחת. כל ספר נשאר פריט מלאי עצמאי עם המספר, הברקוד, המפקיד, המיקום, התמונות והניתוחים שלו."
      width="lg"
    >
      <div className="space-y-4">
        {problems.length > 0 && (
          <div role="alert" className="flex gap-2 rounded-lg bg-danger-soft px-3.5 py-3 text-[13.5px] leading-relaxed text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <ul className="space-y-1">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">בחרו איזה מספר פריט יישמר</legend>
          <div className="divide-y divide-rule overflow-hidden rounded-lg border border-rule">
            {sorted.map((l) => (
              <label key={l.id} className={cn("flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13.5px] hover:bg-stone-2", keep === l.id && "bg-accent-soft/50")}>
                <input type="radio" name="keep-lot" checked={keep === l.id} onChange={() => setKeep(l.id)} className="size-4 accent-[var(--color-ink)]" />
                <span className="num w-10 shrink-0 text-[15px] font-semibold">{l.lotNumber}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.title}</span>
                  <span className="block truncate text-[12.5px] text-muted">
                    <span className="num font-mono text-[11.5px]">{l.inventoryNumber}</span>
                    {l.consignorName && <span> · מפקיד: {l.consignorName}</span>}
                  </span>
                </span>
                {keep === l.id ? <span className="shrink-0 text-[12px] font-medium text-accent">נשמר</span> : <span className="shrink-0 text-[12px] text-faint">יאוחד</span>}
              </label>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            הפריטים האחרים ייסגרו כפריטים נפרדים אך יישמרו בהיסטוריה. אחרי האיחוד מספרי הפריטים בקטלוג יסתדרו מחדש ברצף, בלי חוסרים.
          </p>
        </fieldset>

        {anyPrice && (
          <fieldset className="rounded-lg border border-rule p-3.5">
            <legend className="px-1 text-[13px] font-medium text-ink-2">מחיר פתיחה ללוט המשולב</legend>
            <p className="mb-2 text-[12.5px] leading-relaxed text-muted">
              המחירים הקודמים: {sorted.map((l) => `פריט ${l.lotNumber} ${formatUsd(l.startingPrice)}`).join(" · ")}. הלוט נמכר כיחידה אחת, לכן המחירים אינם מסוכמים אוטומטית. המחירים הקודמים נשמרים בהיסטוריה.
            </p>
            <label className="flex items-center gap-2 py-1 text-[13.5px]">
              <input type="radio" name="price-mode" checked={priceMode === "new"} onChange={() => setPriceMode("new")} className="size-4 accent-[var(--color-ink)]" />
              מחיר חדש:
              <Input dir="ltr" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} onFocus={() => setPriceMode("new")} placeholder="ללא מחיר" aria-label="מחיר פתיחה חדש בדולרים" className="w-32" />
            </label>
            <label className="flex items-center gap-2 py-1 text-[13.5px]">
              <input type="radio" name="price-mode" checked={priceMode === "keep"} onChange={() => setPriceMode("keep")} className="size-4 accent-[var(--color-ink)]" />
              להשאיר את מחיר הפריט שנשמר ({formatUsd(sorted.find((l) => l.id === keep)?.startingPrice)})
            </label>
          </fieldset>
        )}

        <Field label="כותרת משותפת (לא חובה)" hint="אפשר להשאיר ריק ולקבוע אחרי האיחוד, ידנית או ביצירת תיאור משותף ב-AI.">
          {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="למשל: אוסף חידושים של רבי פלוני" />}
        </Field>
      </div>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" icon={<Layers />} loading={busy} disabled={problems.length > 0 || !keep} onClick={run}>
          איחוד {sorted.length} ספרים ללוט {sorted.find((l) => l.id === keep)?.lotNumber ?? ""}
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
