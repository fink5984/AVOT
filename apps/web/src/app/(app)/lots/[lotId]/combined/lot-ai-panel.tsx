"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, History, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/field";
import { Panel } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { fmt } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { LotAiRunSummary } from "@/server/services/lot-ai";

interface AiState {
  compositionVersion: number;
  descriptionNeedsUpdate: boolean;
  appliedBasedOnOlderComposition: boolean;
  appliedRunId: string | null;
  available: boolean;
  unapproved: { itemId: string; inventoryNumber: string; title: string }[];
  settings: { provider: string; model: string } | null;
  runs: LotAiRunSummary[];
}

/**
 * "יצירת תיאור משותף ב-AI": a request of its own for the whole lot, separate from the analysis of each book's photos.
 * The model is the one chosen in the AI settings tab (nothing to pick here). The result is a PREVIEW: the lot's text
 * changes only when the user applies it, the older text stays in the version history, and a text written for an older
 * set of books is marked "needs an update" and cannot be applied.
 */
export function LotAiPanel({ lotId, canGenerate, canApply, initialNeedsUpdate }: { lotId: string; canGenerate: boolean; canApply: boolean; initialNeedsUpdate: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<AiState | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ runId: string; title: string; shortDescription: string; description: string } | null>(null);

  const load = useCallback(async () => {
    setState(await api<AiState>(`/api/lots/${lotId}/ai`));
  }, [lotId]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  // the newest finished proposal that still fits the lot and was neither applied nor rejected: shown as the preview
  const preview = state?.runs.find((r) => r.status === "COMPLETED" && !r.appliedAt && !r.discardedAt && !r.stale) ?? null;
  useEffect(() => {
    if (preview && edit?.runId !== preview.id) setEdit({ runId: preview.id, title: preview.proposedTitle ?? "", shortDescription: preview.proposedShortDescription ?? "", description: preview.proposedDescription ?? "" });
    if (!preview && edit) setEdit(null);
  }, [preview, edit]);

  async function generate() {
    setBusy(true);
    try {
      await api(`/api/lots/${lotId}/ai`, { method: "POST" });
      toast.success("נוצרה הצעה לתיאור משותף", { detail: "בדקו את התצוגה המקדימה. הלוט לא ישתנה עד שתאשרו." });
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || !edit) return;
    setBusy(true);
    try {
      await api(`/api/lot-ai-runs/${preview.id}`, {
        method: "POST",
        json: {
          action: "apply",
          title: edit.title,
          shortDescription: edit.shortDescription.trim() || null,
          description: edit.description,
        },
      });
      toast.success("התיאור המשותף הוחל על הלוט", { detail: "הגרסה הקודמת נשמרה בהיסטוריית הלוט." });
      await load();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!preview) return;
    setBusy(true);
    try {
      await api(`/api/lot-ai-runs/${preview.id}`, { method: "POST", json: { action: "discard" } });
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await api(`/api/lots/${lotId}/ai`, { method: "PATCH" });
      await load();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const needsUpdate = state ? state.descriptionNeedsUpdate : initialNeedsUpdate;
  const history = (state?.runs ?? []).filter((r) => r.id !== preview?.id);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" aria-hidden />
          תיאור משותף
        </span>
      }
      actions={
        canGenerate && (
          <Button size="sm" variant="primary" icon={<Sparkles />} loading={busy} disabled={!!state && (!state.available || state.unapproved.length > 0)} onClick={generate}>
            יצירת תיאור משותף ב-AI
          </Button>
        )
      }
    >
      <div className="space-y-4 p-4 text-[13.5px]">
        {needsUpdate && (
          <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg bg-warn-soft px-3.5 py-3 text-warn">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 leading-relaxed">
              <b>התיאור המשותף דורש עדכון.</b> הוא נכתב להרכב קודם של הלוט (נוספו או הוסרו ספרים). התיאור לא נמחק ולא פורסם מחדש; אפשר ליצור תיאור חדש או לאשר שהתיאור הקיים עדיין מתאים.
              {state?.appliedBasedOnOlderComposition && <span> הניתוח המוחל מבוסס על הרכב קודם.</span>}
            </div>
            {canApply && (
              <Button size="sm" disabled={busy} onClick={dismiss}>
                התיאור עדיין מתאים
              </Button>
            )}
          </div>
        )}

        {state && state.unapproved.length > 0 && (
          <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn">
            יצירת תיאור משותף אפשרית רק אחרי שפרטי כל הספרים בלוט נבדקו ואושרו. ממתינים לאישור:{" "}
            {state.unapproved.map((u, i) => (
              <span key={u.itemId}>
                {i > 0 && ", "}
                <a href={`/inventory/${u.itemId}`} className="num font-mono underline">{u.inventoryNumber}</a>
              </span>
            ))}
            .
          </p>
        )}
        <p className="text-[12.5px] leading-relaxed text-muted">
          התיאור נכתב על סמך הפרטים השמורים של כל הספרים (ביבליוגרפיה, תיאורים קיימים, הערות מצב וממצאים), ומעדיף מידע שאושר בידי אדם. מידע שטרם אושר יסומן כלא מאומת.
          {state?.settings ? (
            <> המודל הפעיל מוגדר בהגדרות ה-AI ({state.settings.model}).</>
          ) : state && !state.available ? (
            <span className="text-danger"> ה-AI אינו מוגדר בשרת.</span>
          ) : null}
        </p>

        {preview && edit && (
          <div className="space-y-3 rounded-lg border border-accent/40 bg-accent-soft/20 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[14px]">תצוגה מקדימה</b>
              <span className="text-[12px] text-muted">
                {preview.model} · {fmt.relative(preview.createdAt)}
                {preview.costUsd !== null && <> · ${preview.costUsd.toFixed(3)}{preview.costEstimated ? " (הערכה)" : ""}</>}
              </span>
              <span className="rounded bg-paper px-1.5 py-0.5 text-[11.5px] text-muted">לא נשמר בלוט עד לאישור</span>
            </div>
            {preview.unverifiedInfoUsed && <p className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">בתיאור נעשה שימוש במידע שטרם אושר בידי אדם. הוא מנוסח בזהירות; כדאי לבדוק לפני האישור.</p>}
            {preview.mainFeature?.text && (
              <p className="text-[13px]">
                <b>המאפיין החשוב ביותר:</b> {preview.mainFeature.text} {preview.mainFeature.verified ? <span className="text-green">(מאומת)</span> : <span className="text-warn">(לא מאומת)</span>}
              </p>
            )}
            {preview.sharedSignificance?.status === "found" && preview.sharedSignificance.note && (
              <p className="text-[13px]">
                <b>חשיבות משותפת לקבוצה:</b> {preview.sharedSignificance.note}
              </p>
            )}
            <label className="block text-[12.5px] font-medium text-ink-2">
              כותרת משותפת
              <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} readOnly={!canApply} maxLength={300} className="mt-1" />
            </label>
            <label className="block text-[12.5px] font-medium text-ink-2">
              תקציר
              <Textarea value={edit.shortDescription} onChange={(e) => setEdit({ ...edit, shortDescription: e.target.value })} readOnly={!canApply} rows={2} className="mt-1" />
            </label>
            <label className="block text-[12.5px] font-medium text-ink-2">
              תיאור קטלוגי משותף
              <Textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} readOnly={!canApply} rows={12} className="mt-1 leading-relaxed" />
            </label>
            {preview.warnings.length > 0 && (
              <div className="rounded-md bg-stone px-3 py-2 text-[12.5px]">
                <b className="text-ink-2">לתשומת לב הבודק:</b>
                <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {canApply && (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Check />} loading={busy} disabled={!edit.title.trim() || !edit.description.trim()} onClick={apply}>
                  החלה על הלוט
                </Button>
                <Button disabled={busy} onClick={discard}>
                  דחייה
                </Button>
              </div>
            )}
          </div>
        )}

        {history.length > 0 && (
          <details className="rounded-lg border border-rule">
            <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-ink-2">
              <History className="size-4" aria-hidden /> היסטוריית יצירות AI של הלוט ({history.length})
            </summary>
            <ul className="divide-y divide-rule border-t border-rule">
              {history.map((r) => (
                <li key={r.id} className="px-3.5 py-2.5 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{fmt.dateTime(r.createdAt)}</span>
                    <span className="text-muted">{r.model}</span>
                    <span className="num text-muted">{r.members.length} ספרים</span>
                    {r.costUsd !== null && <span className="num text-muted">${r.costUsd.toFixed(3)}</span>}
                    {r.status === "FAILED" && <span className="text-danger">נכשל</span>}
                    {r.appliedAt && <span className={cn("rounded bg-green-soft px-1.5 py-0.5 text-green")}>הוחל (גרסה {r.appliedVersion})</span>}
                    {r.discardedAt && <span className="text-muted">נדחה</span>}
                    {r.stale && r.status === "COMPLETED" && <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">מבוסס על הרכב קודם</span>}
                  </div>
                  {r.error && <p className="mt-1 text-danger">{r.error}</p>}
                  {r.proposedTitle && <p className="mt-1 truncate text-muted">{r.proposedTitle}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Panel>
  );
}
