"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { compareRuns } from "@/server/services/ai-analysis";

type Comparison = Awaited<ReturnType<typeof compareRuns>>;
type Side = "a" | "b";

const KIND_TONE: Record<string, string> = { differs: "bg-warn-soft", onlyA: "bg-info-soft", onlyB: "bg-info-soft" };
const CONF: Record<string, string> = { high: "גבוה", medium: "בינוני", low: "נמוך" };

/**
 * Two AI runs of one item side by side: every field, the main feature, the findings, cost and time, and - the point of
 * the screen - whether the INPUT of the two runs was the same. It never ranks the runs: an empty field may be the more
 * accurate answer. A run that is not applied yet can be applied here, all of it or the chosen fields.
 */
export function RunCompare({ itemId, aId, bId, canApply, onClose, onApplied }: { itemId: string; aId: string; bId: string; canApply: boolean; onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<Side, Set<string>>>({ a: new Set(), b: new Set() });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    api<Comparison>(`/api/inventory/${itemId}/ai/compare?a=${aId}&b=${bId}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [itemId, aId, bId]);

  if (error) return <p className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">{error}</p>;
  if (!data) return <p className="px-1 py-3 text-[13px] text-muted">טוען השוואה…</p>;

  const toggle = (side: Side, key: string) =>
    setPicked((p) => {
      const next = new Set(p[side]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...p, [side]: next };
    });

  async function apply(side: Side, all: boolean) {
    const run = data![side].meta;
    const fields = [...picked[side]];
    if (!all && !fields.length) {
      toast.warning("סמנו לפחות שדה אחד להחלה");
      return;
    }
    if (!window.confirm(all ? "להחיל את כל תוצאת הניתוח על פרטי הפריט? הערכים הנוכחיים נשמרים בהיסטוריה וניתן לשחזר." : `להחיל ${fields.length} שדות נבחרים על פרטי הפריט? הערכים הנוכחיים נשמרים בהיסטוריה וניתן לשחזר.`)) return;
    setBusy(`${side}-${all ? "all" : "some"}`);
    try {
      const r = await api<{ fields: string[] }>(`/api/ai/runs/${run.id}/apply`, { method: "POST", json: all ? {} : { fields } });
      toast.success(`הוחלו ${r.fields.length} שדות. מצב הפריט חזר ל"ממתין לבדיקה".`);
      onApplied();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const head = (side: Side) => {
    const m = data[side].meta;
    return (
      <div className="space-y-0.5">
        <div className="font-semibold" dir="ltr">
          {m.provider} · {m.model}
          {m.reasoning ? ` · ${m.reasoning}` : ""}
        </div>
        <div className="text-[12px] text-muted">{fmt.dateTime(new Date(m.createdAt))}</div>
        <div className="text-[12px]">{m.applied ? <span className="text-ink-2">הוחל על הפריט</span> : <span className="text-info">שמור להשוואה, טרם הוחל</span>}</div>
      </div>
    );
  };

  const sideCell = (side: Side, row: Comparison["rows"][number]) => {
    const c = row[side];
    const pendingSide = !data[side].meta.applied && canApply;
    return (
      <td className={cn("align-top px-3 py-2", KIND_TONE[row.kind])}>
        <div className="flex items-start gap-2">
          {pendingSide && c.value && (
            <input type="checkbox" className="mt-1 size-4 shrink-0 cursor-pointer accent-[var(--color-ink)]" checked={picked[side].has(row.key)} onChange={() => toggle(side, row.key)} aria-label={`החלת ${row.label}`} />
          )}
          <div className="min-w-0">
            {c.value ? <div className="whitespace-pre-line">{c.value}</div> : <div className="text-faint">{c.status === "unknown" ? "לא זוהה" : c.status === "not_checked" ? "לא נבדק" : c.status === "not_applicable" ? "לא רלוונטי" : "-"}</div>}
            {c.value && c.confidence && c.confidence !== "high" && <div className="text-[11.5px] text-warn">ביטחון {CONF[c.confidence]}</div>}
          </div>
        </div>
      </td>
    );
  };

  const s = data.summary;
  return (
    <section className="space-y-4 rounded-lg border border-rule bg-paper px-4 py-4 text-[13px]" aria-label="השוואת ניתוחים">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold">השוואת ניתוחים</h3>
        <Button size="sm" variant="ghost" icon={<X />} onClick={onClose}>
          סגירה
        </Button>
      </div>

      {data.warnings.length > 0 ? (
        <div className="space-y-1 rounded-md bg-warn-soft px-3 py-2.5 text-warn" role="alert">
          {data.warnings.map((w, i) => (
            <p key={i} className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {w}
            </p>
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-ink-2">
          <CheckCircle2 className="size-4 text-info" aria-hidden />
          תנאי הקלט זהים (נתוני מקור, תמונות, פרומפט וספריית דוגמאות): ההבדלים בתוצאה נובעים מהמודל.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-start">
          <thead>
            <tr className="border-b border-rule text-start">
              <th className="w-28 px-3 py-2 text-start font-medium text-muted">שדה</th>
              <th className="px-3 py-2 text-start">{head("a")}</th>
              <th className="px-3 py-2 text-start">{head("b")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {data.rows.map((row) => (
              <tr key={row.key}>
                <td className="align-top px-3 py-2 font-medium text-ink-2">{row.label}</td>
                {sideCell("a", row)}
                {sideCell("b", row)}
              </tr>
            ))}
            <tr>
              <td className="align-top px-3 py-2 font-medium text-ink-2">חתימות וממצאים</td>
              {(["a", "b"] as const).map((side) => (
                <td key={side} className="align-top px-3 py-2">
                  {data[side].findings.length ? (
                    <ul className="space-y-1">
                      {data[side].findings.map((f, i) => (
                        <li key={i} className={cn("rounded px-1.5 py-0.5", (side === "a" ? s.findingsOnlyA : s.findingsOnlyB).includes(f) && "bg-info-soft")}>
                          {f}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-faint">אין</span>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <td className="align-top px-3 py-2 font-medium text-ink-2">המאפיין המרכזי</td>
              {(["a", "b"] as const).map((side) => {
                const h = data[side].highlight;
                return (
                  <td key={side} className="align-top px-3 py-2">
                    {h?.status === "found" && h.mainFeature ? (
                      <div>
                        <div className="inline-flex items-center gap-1 font-medium">
                          <Sparkles className="size-3.5 text-info" aria-hidden />
                          {h.mainFeature}
                        </div>
                        <div className="text-[12px] text-muted">{h.verified ? "מאומת" : "לא מאומת"}{h.confidence ? ` · ביטחון ${CONF[h.confidence]}` : ""}</div>
                      </div>
                    ) : (
                      <span className="text-faint">{h ? "אין מאפיין מיוחד מבוסס" : "לא נבדק בניתוח זה"}</span>
                    )}
                  </td>
                );
              })}
            </tr>
            <tr>
              <td className="align-top px-3 py-2 font-medium text-ink-2">לא ודאי / דורש בדיקה</td>
              {(["a", "b"] as const).map((side) => (
                <td key={side} className="align-top px-3 py-2">
                  {data[side].uncertain.length ? (
                    <ul className="list-disc space-y-0.5 ps-4 text-ink-2">
                      {data[side].uncertain.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-faint">-</span>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <td className="align-top px-3 py-2 font-medium text-ink-2">עלות וזמן</td>
              {(["a", "b"] as const).map((side) => {
                const m = data[side].meta;
                return (
                  <td key={side} className="num align-top px-3 py-2">
                    {m.costUsd === null ? "-" : `$${m.costUsd.toFixed(4)}`} · {m.durationMs === null ? "-" : `${Math.round(m.durationMs / 1000)} ש׳`}
                    <div className="text-[12px] text-muted">
                      {m.inputTokens ?? "-"} / {m.outputTokens ?? "-"} טוקנים
                    </div>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="rounded-md bg-stone-2 px-3 py-2.5">
        <div className="font-medium">סיכום (ללא קביעה איזה ניתוח טוב יותר)</div>
        <ul className="mt-1 list-disc space-y-0.5 ps-5 text-ink-2">
          <li>
            שדות שזוהו: <span className="num">{s.foundA}</span> בראשון, <span className="num">{s.foundB}</span> בשני. מודל שהשאיר שדה ריק במקום לנחש עשוי להיות מדויק יותר.
          </li>
          {s.onlyB.length > 0 && <li>זוהו רק בשני: {s.onlyB.join(", ")}</li>}
          {s.onlyA.length > 0 && <li>זוהו רק בראשון: {s.onlyA.join(", ")}</li>}
          {s.differ.length > 0 && <li>הניתוחים חלוקים: {s.differ.join(", ")}</li>}
        </ul>
      </div>

      <details className="rounded-md border border-rule px-3 py-2">
        <summary className="cursor-pointer font-medium">תנאי הקלט של שתי ההרצות</summary>
        <table className="mt-2 w-full text-start text-[12.5px]">
          <tbody className="divide-y divide-rule">
            {data.inputRows.map((r) => (
              <tr key={r.key} className={cn(!r.same && r.affectsComparability && "bg-warn-soft")}>
                <td className="px-2 py-1.5 font-medium text-ink-2">{r.label}</td>
                <td className="px-2 py-1.5" dir="ltr">{r.a ?? "לא ידוע"}</td>
                <td className="px-2 py-1.5" dir="ltr">{r.b ?? "לא ידוע"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {canApply && (["a", "b"] as const).some((side) => !data[side].meta.applied) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
          {(["a", "b"] as const).map(
            (side) =>
              !data[side].meta.applied && (
                <span key={side} className="inline-flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="primary" loading={busy === `${side}-all`} disabled={!!busy} onClick={() => void apply(side, true)}>
                    החלת כל תוצאת הניתוח {side === "a" ? "הראשון" : "השני"}
                  </Button>
                  <Button size="sm" loading={busy === `${side}-some`} disabled={!!busy || picked[side].size === 0} onClick={() => void apply(side, false)}>
                    החלת השדות שסומנו ({picked[side].size})
                  </Button>
                </span>
              ),
          )}
          <span className="text-[12px] text-muted">הערכים הנוכחיים נשמרים בהיסטוריה וניתן לשחזר.</span>
        </div>
      )}
    </section>
  );
}
