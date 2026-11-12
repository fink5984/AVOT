"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Panel } from "@/components/ui/misc";
import { LotPriceCell } from "@/components/lot-price";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { formatUsd } from "@/lib/money";
import { fmt } from "@/i18n";

interface HistoryRow {
  id: string;
  kind: string;
  previous: string | null;
  next: string | null;
  note: string | null;
  by: string | null;
  at: string;
}

const KIND: Record<string, string> = {
  SET: "נקבע",
  CHANGE: "שונה",
  CLEAR: "נמחק",
  MERGED_INTO: "אוחד ללוט אחר",
  MERGED_FROM: "איחוד לוטים",
  DISSOLVED: "פירוק לוט משולב",
  ENDED: "השיוך הסתיים",
  DELETED: "השיוך נמחק",
};

/** The lot page's price area: the starting price (USD) with quick edit and the history of every change. */
export function LotPricePanel({ lotId, price, version, canEdit, ended }: { lotId: string; price: string | null; version: number; canEdit: boolean; ended: boolean }) {
  const toast = useToast();
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  async function toggle() {
    if (history) return setHistory(null);
    try {
      setHistory((await api<{ history: HistoryRow[] }>(`/api/lots/${lotId}/price`)).history);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Panel title="מחיר פתיחה">
      <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <LotPriceCell lotId={lotId} price={price} version={version} canEdit={canEdit && !ended} size="lg" />
        <button type="button" onClick={toggle} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
          <History className="size-3.5" aria-hidden />
          היסטוריה
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">בדולרים (USD). ללא מחיר = טרם נקבע.{ended ? " השיוך הסתיים, המחיר נשמר כהיסטוריה." : ""}</p>
      {history && (
        <ul className="mt-3 divide-y divide-rule text-[12.5px]">
          {history.length === 0 && <li className="py-2 text-muted">אין שינויים רשומים</li>}
          {history.map((h) => (
            <li key={h.id} className="py-1.5">
              <span className="font-medium">{KIND[h.kind] ?? h.kind}</span>{" "}
              <span className="num text-ink-2">
                {formatUsd(h.previous, "ללא")} ← {formatUsd(h.next, "ללא")}
              </span>
              <div className="text-muted">
                {h.by ?? "—"} · {fmt.date(h.at)}
                {h.note ? ` · ${h.note}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>
    </Panel>
  );
}
