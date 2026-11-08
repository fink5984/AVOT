"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert, Sparkles } from "lucide-react";
import type { AiAnalysisStatus } from "@avot/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";

/*
 * The AI button of one item (inventory table row and book page, next to camera / printer). Its state is the
 * database's (item.aiStatus), so it is the same after a refresh:
 *   NOT_RUN    blue        → click starts the analysis
 *   QUEUED/RUNNING spinner → polls the server; a second click only says it is still running
 *   COMPLETED  grey        → click opens "ניתוח AI חוזר" (a manager's password, verified on the server)
 *   FAILED     red         → the message in the tooltip; retry directly when no analysis ever succeeded
 * Every click carries its own request key, so a double click never queues two runs.
 */

export interface AiButtonState {
  aiStatus: AiAnalysisStatus;
  hasAiResult: boolean;
  aiError: string | null;
}

const POLL_MS = 3000;

interface ServerState {
  aiStatus: AiAnalysisStatus;
  aiError: string | null;
  hasSuccessfulAnalysis: boolean;
}

export function useAiRun(itemId: string, initial: AiButtonState, onFinished?: (s: ServerState) => void) {
  const [state, setState] = useState(initial);
  const active = state.aiStatus === "QUEUED" || state.aiStatus === "RUNNING";
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => setState(initial), [initial.aiStatus, initial.hasAiResult, initial.aiError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api<ServerState>(`/api/inventory/${itemId}/ai`);
        if (stop) return;
        setState({ aiStatus: s.aiStatus, hasAiResult: s.hasSuccessfulAnalysis, aiError: s.aiError });
        if (s.aiStatus !== "QUEUED" && s.aiStatus !== "RUNNING") {
          finished.current?.(s);
          return;
        }
      } catch {
        /* temporary: keep polling */
      }
      if (!stop) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [active, itemId]);

  const start = useCallback(
    async (approval?: { email: string; password: string }) => {
      const r = await api<{ state: ServerState }>(`/api/inventory/${itemId}/ai`, { method: "POST", json: { requestKey: crypto.randomUUID(), ...(approval ? { approval } : {}) } });
      setState({ aiStatus: r.state.aiStatus, hasAiResult: r.state.hasSuccessfulAnalysis, aiError: r.state.aiError });
    },
    [itemId],
  );
  return { state, active, start };
}

export function AiAnalyzeButton({
  itemId,
  inventoryNumber,
  initial,
  size = "md",
  defaultApproverEmail,
}: {
  itemId: string;
  inventoryNumber: string;
  initial: AiButtonState;
  size?: "sm" | "md";
  /** prefilled in the re-analysis dialog when the current user is a manager */
  defaultApproverEmail?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [reanalyze, setReanalyze] = useState(false);
  const { state, active, start } = useAiRun(itemId, initial, (s) => {
    if (s.aiStatus === "COMPLETED") toast.success(`ניתוח AI הושלם: ${inventoryNumber}`, { detail: "הפרטים עודכנו וממתינים לבדיקה אנושית" });
    else if (s.aiStatus === "FAILED") toast.error(`ניתוח AI נכשל: ${inventoryNumber}`, { detail: s.aiError ?? undefined });
    router.refresh();
  });

  async function onClick() {
    if (busy) return;
    if (active) {
      toast.info("הניתוח עדיין פעיל", { detail: "אפשר להמשיך לעבוד; הכפתור יתעדכן בסיומו." });
      return;
    }
    if (state.hasAiResult) {
      setReanalyze(true);
      return;
    }
    setBusy(true);
    try {
      await start();
      toast.info(`ניתוח AI התחיל: ${inventoryNumber}`, { detail: "הניתוח רץ ברקע. אפשר להמשיך לעבוד." });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const label =
    active ? `ניתוח AI פעיל (${state.aiStatus === "QUEUED" ? "בתור" : "בניתוח"})`
    : state.aiStatus === "FAILED" ? `ניתוח AI נכשל${state.aiError ? `: ${state.aiError}` : ""}${state.hasAiResult ? " - ניתוח חוזר באישור מנהל" : " - לחצו לניסיון חוזר"}`
    : state.hasAiResult ? "נותח ב-AI - ניתוח חוזר באישור מנהל"
    : `ניתוח AI ל-${inventoryNumber}`;

  return (
    <>
      <IconButton label={label} size={size} disabled={busy} onClick={() => void onClick()} aria-busy={active || undefined} data-ai-status={state.aiStatus}>
        {active || busy ? (
          <Loader2 className="animate-spin text-info" />
        ) : (
          <Sparkles className={cn(state.aiStatus === "FAILED" ? "text-danger" : state.hasAiResult ? "text-faint" : "text-info")} />
        )}
      </IconButton>
      {reanalyze && (
        <ReanalyzeDialog
          inventoryNumber={inventoryNumber}
          defaultEmail={defaultApproverEmail}
          onClose={() => setReanalyze(false)}
          onApprove={async (approval) => {
            await start(approval);
            setReanalyze(false);
            toast.info(`ניתוח AI חוזר התחיל: ${inventoryNumber}`, { detail: "הניתוח רץ ברקע." });
          }}
        />
      )}
    </>
  );
}

function ReanalyzeDialog({
  inventoryNumber,
  defaultEmail,
  onClose,
  onApprove,
}: {
  inventoryNumber: string;
  defaultEmail?: string;
  onClose: () => void;
  onApprove: (approval: { email: string; password: string }) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    setError(null);
    try {
      await onApprove({ email: String(f.get("email") ?? "").trim(), password: String(f.get("password") ?? "") });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="ניתוח AI חוזר" description={`הפריט ${inventoryNumber} כבר נותח.`} width="sm">
      <div className="mb-4 flex gap-2.5 rounded-md bg-warn-soft px-3 py-2.5 text-[13px] text-warn" role="alert">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          הניתוח החדש יחליף את פרטי הניתוח הקודם. ערכים שנשמרו לפני ההחלפה (כולל עריכות ידניות) נשמרים בהיסטוריה וניתן לשחזר אותם. בסיום, מצב פרטי הפריט יחזור ל&quot;ממתין לבדיקה&quot;.
        </p>
      </div>
      <form id="reanalyze-form" onSubmit={submit} className="space-y-3">
        <p className="text-[13px] text-muted">נדרש אישור מנהל: אימייל וסיסמה של משתמש מנהל.</p>
        <Field label="אימייל המנהל" required>
          {(p) => <Input {...p} name="email" type="email" dir="ltr" required autoComplete="username" defaultValue={defaultEmail ?? ""} />}
        </Field>
        <Field label="סיסמת המנהל" required>
          {(p) => <Input {...p} name="password" type="password" dir="ltr" required autoComplete="current-password" autoFocus={!!defaultEmail} />}
        </Field>
        {error && (
          <p className="rounded-md bg-danger-soft px-3 py-2.5 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="mt-5 flex gap-2">
        <Button type="submit" form="reanalyze-form" variant="primary" loading={saving}>
          אישור והתחלת ניתוח
        </Button>
        <Button onClick={onClose}>ביטול</Button>
      </div>
    </Dialog>
  );
}
