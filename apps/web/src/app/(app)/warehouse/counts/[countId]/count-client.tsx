"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import type { CountReport } from "@/server/services/counting";

export function CountReview({ report, canApprove }: { report: CountReport; canApprove: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [apply, setApply] = useState<Set<string>>(new Set([...report.wrongLocation, ...report.surplus].map((x) => x.entryId)));
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const flip = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setter(n);
  };

  async function approve() {
    if (!window.confirm(`לאשר? ${apply.size} ספרים יירשמו במיקום שבו נמצאו, ${missing.size} יסומנו "חסר".`)) return;
    setBusy(true);
    try {
      await api(`/api/counts/${report.session.id}/approve`, { method: "POST", json: { applyEntryIds: [...apply], markMissingItemIds: [...missing] } });
      toast.success("הספירה אושרה והתיקונים נרשמו");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!window.confirm("לבטל את הספירה? לא יבוצע שום שינוי.")) return;
    try {
      await api(`/api/counts/${report.session.id}/cancel`, { method: "POST" });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const row = "flex items-center gap-3 px-5 py-2 text-[13px]";
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <Panel title={`חסרים (${report.missing.length}) — רשומים במיקום שנספר אך לא נסרקו`}>
        <ul className="divide-y divide-rule">
          {report.missing.map((m) => (
            <li key={m.itemId} className={row}>
              {canApprove && <input type="checkbox" checked={missing.has(m.itemId)} onChange={() => flip(missing, setMissing, m.itemId)} aria-label={`סימון ${m.inventoryNumber} כחסר`} className="size-4 accent-[var(--color-ink)]" />}
              <span className="num w-28 font-mono text-muted">{m.inventoryNumber}</span>
              <Link href={`/inventory/${m.itemId}`} className="min-w-0 flex-1 truncate hover:underline">{m.title}</Link>
              <span className="num font-mono text-[12px]">{m.locationCode}</span>
            </li>
          ))}
          {report.missing.length === 0 && <li className={row + " text-muted"}>אין</li>}
        </ul>
      </Panel>
      <Panel title={`מיקום שגוי (${report.wrongLocation.length})`}>
        <ul className="divide-y divide-rule">
          {report.wrongLocation.map((w) => (
            <li key={w.entryId} className={row}>
              {canApprove && <input type="checkbox" checked={apply.has(w.entryId)} onChange={() => flip(apply, setApply, w.entryId)} aria-label={`עדכון מיקום ${w.inventoryNumber}`} className="size-4 accent-[var(--color-ink)]" />}
              <span className="num w-28 font-mono text-muted">{w.inventoryNumber}</span>
              <span className="min-w-0 flex-1 truncate">{w.title}</span>
              <span className="num font-mono text-[12px]">{w.recordedCode} ← {w.foundCode}</span>
            </li>
          ))}
          {report.wrongLocation.length === 0 && <li className={row + " text-muted"}>אין</li>}
        </ul>
      </Panel>
      <Panel title={`עודפים (${report.surplus.length}) — נמצאו אך לא רשומים במיקום`}>
        <ul className="divide-y divide-rule">
          {report.surplus.map((s) => (
            <li key={s.entryId} className={row}>
              {canApprove && <input type="checkbox" checked={apply.has(s.entryId)} onChange={() => flip(apply, setApply, s.entryId)} aria-label={`רישום ${s.inventoryNumber}`} className="size-4 accent-[var(--color-ink)]" />}
              <span className="num w-28 font-mono text-muted">{s.inventoryNumber}</span>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="text-[12px] text-muted">{t.physicalStatus[s.physicalStatus as keyof typeof t.physicalStatus]}</span>
              <span className="num font-mono text-[12px]">{s.foundCode}</span>
            </li>
          ))}
          {report.surplus.length === 0 && <li className={row + " text-muted"}>אין</li>}
        </ul>
      </Panel>
      <Panel title="מיקומים">
        <ul className="divide-y divide-rule">
          {report.visited.map((v) => (
            <li key={v.id} className={row}>
              <span className="num w-32 font-mono">{v.code}</span>
              <span className="text-muted">
                נספרו <span className="num">{v.found}</span> · רשומים <span className="num">{v.expected}</span>
              </span>
            </li>
          ))}
          {report.notVisited.map((v) => (
            <li key={v.code} className={row + " text-muted"}>
              <span className="num w-32 font-mono">{v.code}</span> לא נספר ({v.expected} רשומים)
            </li>
          ))}
        </ul>
      </Panel>
      {canApprove && (
        <div className="flex gap-2 xl:col-span-2">
          <Button variant="primary" loading={busy} onClick={approve}>
            אישור התיקונים שנבחרו
          </Button>
          <Button variant="ghost" onClick={cancel}>
            ביטול הספירה
          </Button>
        </div>
      )}
    </div>
  );
}
