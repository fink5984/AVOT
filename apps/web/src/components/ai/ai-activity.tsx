"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";

/*
 * The same AI state for everybody who has the book open. The server decides (item.aiStatus + the active run); this
 * component only polls the small state (GET /api/inventory/:id/ai?lite=1) - every few seconds while an action is
 * running, more slowly while idle (so a page opened before somebody else started an action learns about it) - and
 * refreshes the page when an action finishes: new title, description and formatting appear without a manual reload.
 * Polling pauses while the tab is hidden. Polling was chosen over SSE / WebSocket: it works behind every proxy, survives
 * a server restart without any reconnect logic, and a few small queries per open page are cheap.
 */

type Kind = "analysis" | "reanalysis" | "rewrite";
export interface AiActivityState {
  aiStatus: "NOT_RUN" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  aiError: string | null;
  detailsVersion: number;
  activity: { runId: string; kind: Kind; status: "QUEUED" | "RUNNING" | string; requestedBy: string | null; requestedById: string | null; since: string; instruction?: string | null } | null;
}

const KIND_TEXT: Record<Kind, string> = {
  analysis: "ניתוח AI ראשוני של הספר",
  reanalysis: "ניתוח AI חוזר של הספר",
  rewrite: "הוספת מידע לתיאור הקטלוגי",
};

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 6000;

export function AiActivity({ itemId, initial, currentUserId }: { itemId: string; initial: AiActivityState; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState(initial);
  const last = useRef(initial);
  const runId = useRef(initial.activity?.runId ?? null);
  const active = state.aiStatus === "QUEUED" || state.aiStatus === "RUNNING";

  // a refresh of the page (props) is the newest truth
  useEffect(() => {
    setState(initial);
    last.current = initial;
    runId.current = initial.activity?.runId ?? null;
  }, [initial.aiStatus, initial.detailsVersion, initial.activity?.runId, initial.activity?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const s = await api<AiActivityState>(`/api/inventory/${itemId}/ai?lite=1`);
          if (stop) return;
          const before = last.current;
          const wasActive = before.aiStatus === "QUEUED" || before.aiStatus === "RUNNING";
          const nowActive = s.aiStatus === "QUEUED" || s.aiStatus === "RUNNING";
          last.current = s;
          setState(s);
          if (wasActive && !nowActive) {
            // finished (possibly by somebody else): say what happened, then load the new text and formatting
            const kind = runId.current ? (before.activity?.kind ?? "analysis") : "analysis";
            const who = before.activity?.requestedBy && before.activity.requestedById !== currentUserId ? ` (הופעל על ידי ${before.activity.requestedBy})` : "";
            if (s.aiStatus === "FAILED") toast.error(`${KIND_TEXT[kind]} נכשל${who}`, { detail: s.aiError ?? undefined });
            else toast.success(`העיבוד הושלם: ${KIND_TEXT[kind]}${who}`, { detail: s.detailsVersion !== before.detailsVersion ? "הכותרת והתיאור עודכנו." : undefined });
            runId.current = null;
            router.refresh();
          } else if (!wasActive && nowActive) {
            // somebody started an action while this page was open: the server-rendered parts must lock too
            runId.current = s.activity?.runId ?? null;
            router.refresh();
          } else if (!nowActive && s.detailsVersion !== before.detailsVersion) {
            router.refresh();
          }
        } catch {
          /* temporary: keep polling */
        }
      }
      if (!stop) timer = setTimeout(poll, last.current.aiStatus === "QUEUED" || last.current.aiStatus === "RUNNING" ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    timer = setTimeout(poll, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        timer = setTimeout(poll, 300);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  if (!active || !state.activity) {
    // the live region stays in the page so the end of a run is announced
    return <div role="status" aria-live="polite" className="sr-only" data-testid="ai-activity-idle" />;
  }
  const a = state.activity;
  const mine = a.requestedById === currentUserId;
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-info/30 bg-info-soft px-4 py-3 text-[13px]" role="status" aria-live="polite" data-testid="ai-activity" data-ai-kind={a.kind} data-ai-status={a.status}>
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-info" aria-hidden />
      <div className="min-w-0">
        <div className="font-medium text-ink">
          AI בעיבוד - {KIND_TEXT[a.kind]}
          <span className="ms-2 text-[12px] font-normal text-ink-2">{a.status === "QUEUED" ? "ממתין בתור" : "בעיבוד"}</span>
        </div>
        <div className="text-[12.5px] text-ink-2">
          {mine ? "הפעלת את העיבוד." : a.requestedBy ? `העיבוד הופעל על ידי ${a.requestedBy}.` : null} אפשר לצפות בתמונות ובפרטים הקיימים. התוצאה תישמר בשרת גם אם תצאו מהדף, ותופיע כאן בסיום. אישור סופי ופעולות AI נוספות חסומים עד הסיום.
        </div>
        {a.instruction && <div className="mt-0.5 line-clamp-2 text-[12px] text-muted">ההוראה: {a.instruction}</div>}
      </div>
    </div>
  );
}

/** A small badge for lists (inventory table, catalog): "AI בעיבוד" while an action is running. */
export function AiBusyBadge({ status }: { status: AiActivityState["aiStatus"] }) {
  if (status !== "QUEUED" && status !== "RUNNING") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-[11.5px] font-medium text-info" data-testid="ai-busy-badge">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      AI בעיבוד
    </span>
  );
}
