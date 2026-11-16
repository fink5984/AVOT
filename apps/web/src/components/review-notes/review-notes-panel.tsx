"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleHelp, ClipboardList, Pencil, Plus, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { fmt } from "@/i18n";
import type { ReviewNoteDto } from "@/server/services/review-notes";

/*
 * "הערות לבדיקה": the internal, unverified remarks on ONE book. The same panel (and the same rows) appears on the book's
 * page in the inventory and on its lot page in the catalog; a combined lot shows one panel per book, titled with the book.
 * It is always on the page (never behind a button or a tab), open while there are open notes, and quiet in colour.
 * Nothing written here is ever sent to an AI request - the panel says so - and "verified" copies nothing anywhere: the
 * editor adds a confirmed fact to the book's details by hand.
 *
 * Every change goes to the server with the state the screen saw: a note somebody else handled meanwhile is refused,
 * never overwritten. After a change the page refreshes (the approval warning and the lists read the same rows); a change
 * made by another person arrives through the page's shared poll (AiActivity), which refreshes the page too.
 */

const STATUS_TEXT: Record<ReviewNoteDto["status"], string> = { OPEN: "ממתין לבדיקה", VERIFIED: "נבדק ואומת", NOT_VERIFIED: "נבדק ולא אומת" };
const STATUS_TONE = { OPEN: "warn", VERIFIED: "green", NOT_VERIFIED: "neutral" } as const;
const when = (iso: string) => fmt.dateTime(new Date(iso));

export function ReviewNotesPanel({
  itemId,
  initial,
  canAdd,
  canResolve,
  bookLabel,
  className,
}: {
  itemId: string;
  initial: ReviewNoteDto[];
  canAdd: boolean;
  canResolve: boolean;
  /** a combined lot: which book these notes belong to ("ITM-000184 · שם הספר") */
  bookLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [notes, setNotes] = useState(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [handling, setHandling] = useState<{ id: string; status: "VERIFIED" | "NOT_VERIFIED"; conclusion: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // the page was refreshed (own change, or somebody else's seen by the shared poll): the server's rows are the truth
  const signature = useMemo(() => JSON.stringify(initial.map((n) => [n.id, n.status, n.updatedAt])), [initial]);
  useEffect(() => setNotes(initial), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = notes.filter((n) => n.status === "OPEN");
  const handled = notes.filter((n) => n.status !== "OPEN");

  async function add() {
    const v = text.trim();
    if (!v || busy) return;
    setBusy("add");
    try {
      const r = await api<{ note: ReviewNoteDto }>(`/api/inventory/${itemId}/review-notes`, { method: "POST", json: { text: v } });
      setNotes((cur) => [r.note, ...cur]);
      setText("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function patch(note: ReviewNoteDto, body: Record<string, unknown>, done?: () => void) {
    setBusy(note.id);
    try {
      const r = await api<{ note: ReviewNoteDto }>(`/api/review-notes/${note.id}`, { method: "PATCH", json: { ...body, expectedStatus: note.status } });
      setNotes((cur) => cur.map((n) => (n.id === note.id ? r.note : n)));
      done?.();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const list = (rows: ReviewNoteDto[]) => (
    <ul className="divide-y divide-rule">
      {rows.map((n) => (
        <li key={n.id} className="px-4 py-3 text-[13.5px]" data-testid="review-note" data-note-status={n.status}>
          {editing?.id === n.id ? (
            <div className="space-y-2">
              <Textarea value={editing.text} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} rows={3} maxLength={2000} aria-label="עריכת ההערה" autoFocus />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={busy === n.id} disabled={!editing.text.trim()} onClick={() => void patch(n, { text: editing.text }, () => setEditing(null))}>
                  שמירה
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  ביטול
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-line leading-relaxed text-ink">{n.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                {n.status !== "OPEN" && (
                  <Badge tone={STATUS_TONE[n.status]} dot={false}>
                    {n.status === "VERIFIED" ? <CheckCircle2 className="size-3" aria-hidden /> : <XCircle className="size-3" aria-hidden />}
                    {STATUS_TEXT[n.status]}
                  </Badge>
                )}
                <span>
                  נכתבה{n.createdBy ? ` על ידי ${n.createdBy}` : ""} · {when(n.createdAt)}
                </span>
                {n.resolvedAt && (
                  <span>
                    · נבדקה{n.resolvedBy ? ` על ידי ${n.resolvedBy}` : ""} · {when(n.resolvedAt)}
                  </span>
                )}
              </div>
              {n.conclusion && (
                <p className="mt-1.5 rounded-md bg-stone-2 px-3 py-1.5 text-[13px] text-ink-2">
                  <span className="font-medium">מסקנה:</span> <span className="whitespace-pre-line">{n.conclusion}</span>
                </p>
              )}
              {handling?.id === n.id ? (
                <div className="mt-2 space-y-2 rounded-md border border-rule bg-stone-2/60 p-3">
                  <div className="text-[12.5px] font-medium text-ink-2">{handling.status === "VERIFIED" ? "נבדק ואומת" : "נבדק ולא אומת"} - מסקנה (אפשר להשאיר ריק)</div>
                  <Textarea value={handling.conclusion} onChange={(e) => setHandling({ ...handling, conclusion: e.target.value })} rows={2} maxLength={2000} aria-label="מסקנת הבדיקה" placeholder="מה נמצא, ומאיפה" autoFocus />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" loading={busy === n.id} onClick={() => void patch(n, { status: handling.status, conclusion: handling.conclusion.trim() || null }, () => setHandling(null))}>
                      שמירה
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setHandling(null)}>
                      ביטול
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {n.status === "OPEN" && canResolve && (
                    <>
                      <Button size="sm" icon={<CheckCircle2 />} disabled={!!busy} onClick={() => setHandling({ id: n.id, status: "VERIFIED", conclusion: "" })}>
                        נבדק ואומת
                      </Button>
                      <Button size="sm" icon={<XCircle />} disabled={!!busy} onClick={() => setHandling({ id: n.id, status: "NOT_VERIFIED", conclusion: "" })}>
                        נבדק ולא אומת
                      </Button>
                    </>
                  )}
                  {n.status === "OPEN" && canAdd && (
                    <Button size="sm" variant="ghost" icon={<Pencil />} disabled={!!busy} onClick={() => setEditing({ id: n.id, text: n.text })}>
                      עריכה
                    </Button>
                  )}
                  {n.status !== "OPEN" && canResolve && (
                    <Button size="sm" variant="ghost" icon={<RotateCcw />} loading={busy === n.id} disabled={!!busy} onClick={() => void patch(n, { status: "OPEN" })}>
                      פתיחה מחדש
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <section
      className={cn("overflow-hidden rounded-lg border bg-paper shadow-card", open.length > 0 ? "border-warn/40 bg-warn-soft/30" : "border-rule", className)}
      aria-label={bookLabel ? `הערות לבדיקה - ${bookLabel}` : "הערות לבדיקה"}
      data-testid="review-notes"
      data-open-notes={open.length}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule px-4 py-2.5">
        <h2 className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
          <ClipboardList className="size-4 text-warn" aria-hidden />
          הערות לבדיקה
          {bookLabel && <span className="text-[13px] font-medium text-ink-2">· {bookLabel}</span>}
          {open.length > 0 ? (
            <Badge tone="warn" dot={false} className="num">
              {open.length} פתוחות
            </Badge>
          ) : (
            <span className="text-[12.5px] font-normal text-muted">אין הערות פתוחות</span>
          )}
        </h2>
        <span className="text-[12px] text-muted">פנימי, לא מאומת - לא נשלח ל-AI</span>
      </div>

      {open.length > 0 && list(open)}
      {open.length === 0 && notes.length === 0 && (
        <p className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted">
          <CircleHelp className="size-4 shrink-0" aria-hidden />
          כשיש משהו שדורש בירור, כתבו כאן. ההערה תופיע לכל מי שפותח את הספר, במלאי ובקטלוג.
        </p>
      )}

      {canAdd && (
        <form
          className="border-t border-rule px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void add();
              }
            }}
            rows={2}
            maxLength={2000}
            aria-label="הערה חדשה לבדיקה"
            placeholder="לבדוק אם החתימה היא של… · ייתכן שחסרים דפים בסוף…"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button type="submit" size="sm" variant="primary" icon={<Plus />} loading={busy === "add"} disabled={!text.trim() || (!!busy && busy !== "add")}>
              הוספת הערה
            </Button>
            <span className="text-[12px] text-faint">Ctrl+Enter לשליחה</span>
          </div>
        </form>
      )}

      {handled.length > 0 && (
        <details className="border-t border-rule" open={open.length === 0}>
          <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:text-ink">
            הערות שנבדקו (<span className="num">{handled.length}</span>)
          </summary>
          {list(handled)}
        </details>
      )}
    </section>
  );
}
