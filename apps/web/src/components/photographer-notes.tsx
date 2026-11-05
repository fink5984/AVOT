"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/ui/misc";

/*
 * "הערות המצלם": the photographer's free-text notes on one physical book, autosaved.
 *
 *  - No request per keystroke: a save goes out ~900 ms after the last change (a new change restarts the timer),
 *    when the field loses focus, when the book is left, and when the page is hidden.
 *  - One request at a time. Every save carries `rev`, a counter that only grows (ms timestamp); the server applies a
 *    save only if it is newer than what it holds, so a delayed old request can never overwrite a newer note, and a
 *    late response never marks newer text as saved.
 *  - The unsaved text is also kept as a local draft per book. After a lost connection or a closed tab it is restored
 *    and sent again — but only if it is newer than the server's copy.
 *  - The component belongs to ONE book (the parent keys it by item id): text typed for one book cannot be saved to another.
 */

const DEBOUNCE_MS = 900;
const draftKey = (itemId: string) => `avot.photographerNotes.${itemId}`;

interface Draft {
  text: string;
  rev: number;
}
function readDraft(itemId: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(itemId)) ?? "null") as Draft | null;
    return d && typeof d.text === "string" && typeof d.rev === "number" ? d : null;
  } catch {
    return null;
  }
}
function writeDraft(itemId: string, d: Draft | null) {
  try {
    if (d) localStorage.setItem(draftKey(itemId), JSON.stringify(d));
    else localStorage.removeItem(draftKey(itemId));
  } catch {
    /* storage blocked: autosave still works while online */
  }
}

type Status = "idle" | "dirty" | "saving" | "saved" | "offline" | "error" | "replaced";
interface SaveResult {
  applied: boolean;
  state: { text: string; rev: number | null };
}

const STATUS_TEXT: Record<Status, string> = {
  idle: "",
  dirty: "ממתין לשמירה…",
  saving: "שומר…",
  saved: "נשמר",
  offline: "לא נשמר — ממתין לחיבור",
  error: "השמירה נכשלה",
  replaced: "עודכן ממשתמש אחר",
};

export function PhotographerNotes({
  itemId,
  initialText,
  initialRev,
  canEdit,
  variant,
  autosize = true,
}: {
  itemId: string;
  initialText: string;
  initialRev: number | null;
  canEdit: boolean;
  /** studio: dark capture panel · panel: the light cards of the book / catalog item pages */
  variant: "studio" | "panel";
  autosize?: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [status, setStatus] = useState<Status>("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const textRef = useRef(initialText);
  const revRef = useRef(initialRev ?? 0); // rev of the newest local edit
  const ackedRev = useRef(initialRev ?? 0); // newest rev the server has answered for
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);
  const alive = useRef(true);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current || revRef.current <= ackedRev.current) return;
    const sending = { text: textRef.current, rev: revRef.current };
    inflight.current = true;
    let again = false;
    if (alive.current) setStatus("saving");
    try {
      const r = await api<SaveResult>(`/api/inventory/${itemId}/photographer-notes`, { method: "PUT", json: sending });
      retries.current = 0;
      ackedRev.current = Math.max(ackedRev.current, sending.rev);
      again = revRef.current > ackedRev.current;
      if (!r.applied && r.state.rev !== null && r.state.rev > revRef.current) {
        // somebody saved a newer note meanwhile (another tab / photographer): theirs wins, nothing is lost silently
        textRef.current = r.state.text;
        revRef.current = ackedRev.current = r.state.rev;
        writeDraft(itemId, null);
        if (alive.current) {
          setText(r.state.text);
          setStatus("replaced");
        }
      } else if (revRef.current === sending.rev) {
        writeDraft(itemId, null);
        if (alive.current) setStatus("saved");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        if (alive.current) {
          setStatus("error");
          setErrorText(err.status === 403 ? "אין הרשאה לערוך הערות מצלם" : err.message);
        }
      } else if (alive.current) {
        // no connection / server trouble: keep the text (draft), try again soon and when the connection returns
        setStatus("offline");
        const wait = Math.min(2000 * 2 ** retries.current++, 15000);
        timer.current = setTimeout(() => void flush(), wait);
      }
    } finally {
      inflight.current = false;
    }
    // edits made while the request was out go in the next request (after a failure the retry timer / next edit does it)
    if (again && alive.current && !timer.current) void flush();
  }, [itemId]);

  const change = (value: string) => {
    textRef.current = value;
    revRef.current = Math.max(revRef.current + 1, Date.now());
    writeDraft(itemId, { text: value, rev: revRef.current });
    setText(value);
    setStatus("dirty");
    setErrorText(null);
    retries.current = 0;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  };

  // a draft that never reached the server (closed tab, lost connection) is restored when it is newer than the saved note
  useEffect(() => {
    const d = readDraft(itemId);
    if (d && d.rev > (initialRev ?? 0) && canEdit) {
      textRef.current = d.text;
      revRef.current = d.rev;
      setText(d.text);
      setStatus("dirty");
      void flush();
    } else if (d) writeDraft(itemId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // connection came back / the page is hidden or closed: send what is pending (keepalive survives the page)
  useEffect(() => {
    alive.current = true;
    const online = () => void flush();
    const leaving = () => {
      if (revRef.current <= ackedRev.current) return;
      void fetch(`/api/inventory/${itemId}/photographer-notes`, {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: textRef.current, rev: revRef.current }),
      }).catch(() => undefined);
    };
    const hidden = () => document.visibilityState === "hidden" && leaving();
    window.addEventListener("online", online);
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", hidden);
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      leaving(); // moving to another book / leaving the screen: the pending note is saved for THIS book
    };
  }, [flush, itemId]);

  // grows with the content (a few lines at first)
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !autosize) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, variant === "studio" ? 200 : 320)}px`;
  }, [text, autosize, variant]);

  const statusEl = (
    <span
      role="status"
      aria-live="polite"
      title={errorText ?? undefined}
      className={cn(
        "text-[12px]",
        status === "error" || status === "offline" ? (variant === "studio" ? "text-[#f2a79b]" : "text-danger") : status === "saved" ? (variant === "studio" ? "text-[#3ecf8e]" : "text-green") : variant === "studio" ? "text-studio-muted" : "text-faint",
      )}
    >
      {status === "error" && errorText ? `${STATUS_TEXT.error} — ${errorText}` : STATUS_TEXT[status]}
    </span>
  );

  const field = (
    <textarea
      ref={area}
      value={text}
      onChange={(e) => change(e.target.value)}
      onBlur={() => void flush()}
      readOnly={!canEdit}
      rows={3}
      maxLength={5000}
      aria-label="הערות המצלם"
      placeholder={canEdit ? "חסר דף שער, קרע בכריכה, חתימה בעמוד האחרון…" : "אין הערות מצלם"}
      className={
        variant === "studio"
          ? "block min-h-[4.6rem] w-full resize-none rounded-lg border border-studio-rule bg-studio-3 px-3 py-2 text-[13.5px] leading-relaxed text-studio-text placeholder:text-studio-muted focus:border-white/40 focus:outline-none focus:ring-2 focus:ring-white/10"
          : "block w-full resize-none rounded-none border-0 bg-transparent px-5 py-3.5 text-[13.5px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
      }
    />
  );

  if (variant === "panel") {
    return (
      <Panel title="הערות המצלם" actions={statusEl}>
        {field}
      </Panel>
    );
  }
  return (
    <section className="border-t border-studio-rule px-4 py-3" aria-label="הערות המצלם" data-testid="photographer-notes">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="px-1 text-[12px] font-medium text-studio-muted">הערות המצלם</span>
        {statusEl}
      </div>
      {field}
    </section>
  );
}
