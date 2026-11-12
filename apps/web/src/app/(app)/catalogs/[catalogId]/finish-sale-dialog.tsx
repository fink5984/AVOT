"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatUsd } from "@/lib/money";

interface Preview {
  catalog: { number: string; name: string; finishedAt: string | null; archived: boolean };
  totalLots: number;
  soldLots: number;
  soldBooks: number;
  unsoldLots: number;
  unknownLots: number;
  unknownList: { id: string; lotNumber: number; title: string }[];
  hammerTotal: string;
  buyers: number;
  purchases: number;
  needAttention: number;
  soldWithoutBuyer: number;
  buyersNeedingDetails: number;
  unsoldUndecided: number;
}

/** "סיום מכירה": the numbers first, then what happens to the unsold lots. Lots without a result are never made "unsold" silently. */
export function FinishSaleDialog({ open, onClose, catalogId }: { open: boolean; onClose: () => void; catalogId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [p, setP] = useState<Preview | null>(null);
  const [unsold, setUnsold] = useState("LEAVE");
  const [markUnknown, setMarkUnknown] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setP(null);
    setMarkUnknown(false);
    api<Preview>(`/api/catalogs/${catalogId}/finish`).then(setP).catch((e) => toast.error(errorMessage(e)));
  }, [open, catalogId, toast]);

  async function finish() {
    setBusy(true);
    try {
      const r = await api<{ applied: Record<string, number>; lotsWithoutResult: number }>(`/api/catalogs/${catalogId}/finish`, { method: "POST", json: { unsold, markUnknownUnsold: markUnknown, reason: reason || null } });
      toast.success("המכירה הסתיימה", { detail: r.lotsWithoutResult ? `${r.lotsWithoutResult} לוטים עדיין ללא תוצאה` : "תשלומים ומשלוחים ממשיכים להתנהל כרגיל" });
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    try {
      await api(`/api/catalogs/${catalogId}/close`, { method: "POST" });
      toast.success("הקטלוג הועבר לארכיון. רכישות, תשלומים ומשלוחים ממשיכים להתנהל");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : errorMessage(err));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title="סיום מכירה"
      description="סיום המכרז אינו סיום התשלומים והמשלוחים: אלה נמשכים גם אחרי שהמכירה הסתיימה ואחרי העברת הקטלוג לארכיון."
      footer={
        <>
          <Button onClick={onClose}>סגירה</Button>
          {p?.catalog.finishedAt && !p.catalog.archived && <Button onClick={archive}>העברה לארכיון</Button>}
          <Button variant="primary" loading={busy} disabled={!p || (markUnknown && !reason.trim())} onClick={finish}>
            {p?.catalog.finishedAt ? "עדכון" : "סיום המכירה"}
          </Button>
        </>
      }
    >
      {!p ? (
        <p className="py-6 text-center text-muted">טוען…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4" data-testid="finish-summary">
            <T k="לוטים" v={p.totalLots} />
            <T k="נמכרו" v={p.soldLots} sub={`${p.soldBooks} ספרים`} />
            <T k="לא נמכרו" v={p.unsoldLots} />
            <T k="תוצאה לא ידועה" v={p.unknownLots} warn={p.unknownLots > 0} />
            <T k="סכום פטיש" v={formatUsd(p.hammerTotal, "$0")} />
            <T k="קונים" v={p.buyers} />
            <T k="רכישות" v={p.purchases} />
            <T k="דורשים טיפול נוסף" v={p.needAttention} warn={p.needAttention > 0} />
          </div>
          {p.soldWithoutBuyer > 0 && <p className="text-[13px] text-warn">{p.soldWithoutBuyer} לוטים מסומנים כנמכרו ללא קונה רשום. יש לשייך להם קונה.</p>}
          {p.buyersNeedingDetails > 0 && <p className="text-[13px] text-warn">{p.buyersNeedingDetails} קונים חסרי פרטי זיהוי מלאים.</p>}

          {p.unknownLots > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13.5px]">
              <p className="flex items-center gap-1.5 font-medium text-warn">
                <AlertTriangle className="size-4" aria-hidden />
                {p.unknownLots} לוטים ללא תוצאה. המערכת לא תסמן אותם כ״לא נמכר״ בעצמה.
              </p>
              <p className="mt-1 text-[12.5px] text-ink-2">{p.unknownList.map((l) => l.lotNumber).join(", ")}{p.unknownLots > p.unknownList.length ? "…" : ""}</p>
              <label className="mt-2 flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={markUnknown} onChange={(e) => setMarkUnknown(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
                לסמן במפורש את כולם כ״לא נמכר״
              </label>
              {markUnknown && <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="סיבה (חובה)" className="mt-2" aria-label="סיבה" />}
            </div>
          )}

          <label className="block text-[13.5px]">
            <span className="mb-1 block font-medium">מה קורה ללוטים שלא נמכרו?</span>
            <Select value={unsold} onChange={(e) => setUnsold(e.target.value)} aria-label="טיפול בלוטים שלא נמכרו" className="max-w-md">
              <option value="LEAVE">להחליט אחר כך (נשארים בקטלוג כ״לא נמכר״)</option>
              <option value="HOLD_POST_SALE">להישאר זמינים למכירה לאחר המכרז</option>
              <option value="RELEASE_TO_STOCK">לשחרר למלאי (זמינים לקטלוג חדש)</option>
              <option value="RETURN_TO_CONSIGNOR">להחזיר למפקיד (נוצרת משימת הוצאה)</option>
            </Select>
            <span className="mt-1 block text-[12px] text-muted">ההיסטוריה, התמונות ומחיר הפתיחה נשמרים בכל מסלול. החזרה למפקיד אינה מכירה ללקוח. אפשר להחליט אחרת לכל לוט בנפרד בדף הלוט.</span>
          </label>
        </div>
      )}
    </Dialog>
  );
}

function T({ k, v, warn, sub }: { k: string; v: React.ReactNode; warn?: boolean; sub?: string }) {
  return (
    <div className="rounded-lg bg-stone-2 px-3 py-2">
      <div className="text-[11.5px] text-muted">{k}</div>
      <div className={`num text-[17px] font-semibold ${warn ? "text-danger" : ""}`}>{v}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
